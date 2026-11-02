/* Google Drive transport adapted from Prisma Abyss. Access tokens stay in memory during explicit operations. */
(function(global) {
    'use strict';
    const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
    const GOOGLE_DRIVE_FOLDER_NAME = 'こもれび記録 Backups';
    const GOOGLE_DRIVE_FOLDER_MARKER = 'komorebi-backup-folder-v1';
    const GOOGLE_DRIVE_FILE_MARKER = 'komorebi-record-backup-v1';
    const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
    const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
    const GOOGLE_DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
    // Tokens and account selection responses never enter game saves, browser storage or telemetry.
    let driveAccessToken = '';
    let driveAccessTokenExpiresAt = 0;
    const driveFailure = (message, status) => Object.assign(new Error(message), { driveSafe: true, status });
    const GoogleDriveBackup = {
        gisPromise: null,
        tokenClient: null,
        pendingAuthorization: null,

        getClientId: () => String(
            global.document?.querySelector?.('meta[name="google-drive-client-id"]')?.content
            || ''
        ).trim(),

        isConfigured: () => /^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(GoogleDriveBackup.getClientId()),

        clearSession: () => {
            driveAccessToken = '';
            driveAccessTokenExpiresAt = 0;
        },

        loadIdentityServices: () => {
            if (global.google?.accounts?.oauth2) return Promise.resolve(true);
            if (GoogleDriveBackup.gisPromise) return GoogleDriveBackup.gisPromise;
            GoogleDriveBackup.gisPromise = new Promise((resolve, reject) => {
                const existing = document.querySelector(`script[src="${GOOGLE_IDENTITY_SCRIPT}"]`);
                const script = existing || document.createElement('script');
                const timer = setTimeout(() => { script.remove(); reject(driveFailure('Google Drive認証の準備がタイムアウトしました。もう一度お試しください。')); }, 20000);
                const finish = () => global.google?.accounts?.oauth2
                    ? resolve(true)
                    : reject(new Error('Google Drive認証を読み込めませんでした。'));
                script.addEventListener('load', () => { clearTimeout(timer); finish(); }, { once: true });
                script.addEventListener('error', () => { clearTimeout(timer); script.remove(); reject(driveFailure('Google Drive認証を読み込めませんでした。接続を確認してもう一度お試しください。')); }, { once: true });
                if (!existing) {
                    script.src = GOOGLE_IDENTITY_SCRIPT;
                    script.async = true;
                    script.defer = true;
                    script.referrerPolicy = 'no-referrer';
                    document.head.appendChild(script);
                }
            }).catch(error => {
                GoogleDriveBackup.gisPromise = null;
                throw error;
            });
            return GoogleDriveBackup.gisPromise;
        },

        ensureTokenClient: async () => {
            if (!GoogleDriveBackup.isConfigured()) throw new Error('Google Drive連携の設定が必要です。');
            await GoogleDriveBackup.loadIdentityServices();
            if (GoogleDriveBackup.tokenClient) return GoogleDriveBackup.tokenClient;
            const client = global.google.accounts.oauth2.initTokenClient({
                client_id: GoogleDriveBackup.getClientId(),
                scope: GOOGLE_DRIVE_SCOPE,
                include_granted_scopes: false,
                callback: response => {
                    const pending = GoogleDriveBackup.pendingAuthorization;
                    if (!pending || pending.client !== client) return;
                    GoogleDriveBackup.pendingAuthorization = null;
                    clearTimeout(pending.timer);
                    if (!response?.access_token || response.error) {
                        pending.reject(driveFailure('Google Driveの利用が許可されませんでした。記録データは変更していません。'));
                        return;
                    }
                    const scopes = String(response.scope || '').split(/\s+/).filter(Boolean);
                    if (!scopes.includes(GOOGLE_DRIVE_SCOPE) || scopes.some(scope => scope !== GOOGLE_DRIVE_SCOPE)) {
                        pending.reject(driveFailure('Google Driveの権限を確認できませんでした。もう一度接続してください。'));
                        return;
                    }
                    const expiresIn = Number(response.expires_in);
                    if (!Number.isFinite(expiresIn) || expiresIn <= 60) {
                        pending.reject(driveFailure('Google Driveの認証期限を確認できませんでした。もう一度接続してください。'));
                        return;
                    }
                    driveAccessToken = response.access_token;
                    driveAccessTokenExpiresAt = Date.now() + expiresIn * 1000 - 60000;
                    pending.resolve(response.access_token);
                },
                error_callback: response => {
                    const pending = GoogleDriveBackup.pendingAuthorization;
                    if (!pending || pending.client !== client) return;
                    GoogleDriveBackup.pendingAuthorization = null;
                    if (pending) clearTimeout(pending.timer);
                    pending?.reject(driveFailure('Google Driveの認証を中止しました。画面が開かない場合はポップアップの許可をご確認ください。'));
                }
            });
            GoogleDriveBackup.tokenClient = client;
            return GoogleDriveBackup.tokenClient;
        },

        // Called directly by the Drive button click, before awaiting any work.
        authorize: () => {
            const client = GoogleDriveBackup.tokenClient;
            if (!client) throw driveFailure('Google Drive認証を準備しています。少し待ってからもう一度お試しください。');
            if (GoogleDriveBackup.pendingAuthorization) throw driveFailure('Google Driveの認証処理中です。');
            GoogleDriveBackup.clearSession();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    GoogleDriveBackup.pendingAuthorization = null;
                    GoogleDriveBackup.tokenClient = null;
                    reject(driveFailure('Google Drive認証がタイムアウトしました。もう一度お試しください。'));
                }, 120000);
                GoogleDriveBackup.pendingAuthorization = { resolve, reject, timer, client };
                try { client.requestAccessToken({ prompt: 'select_account' }); }
                catch (_) { clearTimeout(timer); GoogleDriveBackup.pendingAuthorization = null; reject(driveFailure('Google Driveの認証画面を開けませんでした。ポップアップの許可をご確認ください。')); }
            });
        },

        request: async (url, options = {}, asText = false) => {
            const target = new URL(url);
            if (target.origin !== 'https://www.googleapis.com' || !/^\/(?:upload\/)?drive\/v3\/files(?:\/|$)/.test(target.pathname)) {
                throw driveFailure('Google Driveの通信先を確認できませんでした。');
            }
            if (!driveAccessToken || Date.now() >= driveAccessTokenExpiresAt) {
                GoogleDriveBackup.clearSession();
                throw driveFailure('Google Driveの認証期限が切れました。もう一度操作して接続してください。');
            }
            const headers = new Headers(options.headers || {});
            headers.set('Authorization', `Bearer ${driveAccessToken}`);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            try {
                const response = await fetch(target.href, { ...options, headers, signal: controller.signal,
                    credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
                if (!response.ok) {
                    if (response.status === 401) GoogleDriveBackup.clearSession();
                    throw driveFailure(`Google Driveとの通信に失敗しました（${response.status}）。接続・空き容量・利用許可をご確認ください。`, response.status);
                }
                if (response.status === 204) return null;
                return await (asText ? response.text() : response.json());
            } catch (error) {
                if (error?.driveSafe) throw error;
                throw driveFailure('Google Driveとの通信を完了できませんでした。接続を確認してもう一度お試しください。');
            } finally {
                clearTimeout(timer);
            }
        },

        fetchJson: (url, options) => GoogleDriveBackup.request(url, options),

        escapeQueryValue: value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),

        findFolder: async () => {
            const marker = GoogleDriveBackup.escapeQueryValue(GOOGLE_DRIVE_FOLDER_MARKER);
            const query = `mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='komorebiType' and value='${marker}' }`;
            const params = new URLSearchParams({ q: query, spaces: 'drive', fields: 'files(id,name,modifiedTime)', orderBy: 'createdTime asc', pageSize: '10' });
            const result = await GoogleDriveBackup.fetchJson(`${GOOGLE_DRIVE_API}/files?${params}`);
            return result?.files?.[0] || null;
        },

        ensureFolder: async () => {
            const existing = await GoogleDriveBackup.findFolder();
            if (existing) return existing;
            return GoogleDriveBackup.fetchJson(`${GOOGLE_DRIVE_API}/files?fields=id,name,modifiedTime`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: GOOGLE_DRIVE_FOLDER_NAME,
                    mimeType: 'application/vnd.google-apps.folder',
                    appProperties: { komorebiType: GOOGLE_DRIVE_FOLDER_MARKER }
                })
            });
        },

        findBackupFile: async (folderId) => {
            const marker = GoogleDriveBackup.escapeQueryValue(GOOGLE_DRIVE_FILE_MARKER);
            const parent = GoogleDriveBackup.escapeQueryValue(folderId);
            const query = `'${parent}' in parents and trashed=false and appProperties has { key='komorebiType' and value='${marker}' }`;
            const params = new URLSearchParams({
                q: query,
                spaces: 'drive',
                fields: 'files(id,name,modifiedTime,size)',
                orderBy: 'modifiedTime desc',
                pageSize: '10'
            });
            const result = await GoogleDriveBackup.fetchJson(`${GOOGLE_DRIVE_API}/files?${params}`);
            return result?.files?.[0] || null;
        },

        uploadMultipart: async (fileId, folderId, text) => {
            const metadata = {
                name: 'komorebi-backup.json',
                mimeType: 'application/json',
                appProperties: { komorebiType: GOOGLE_DRIVE_FILE_MARKER }
            };
            if (!fileId) metadata.parents = [folderId];
            const boundary = `komorebi_${Date.now()}_${Math.random().toString(16).slice(2)}`;
            const body = new Blob([
                `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
                JSON.stringify(metadata),
                `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
                text,
                `\r\n--${boundary}--`
            ], { type: `multipart/related; boundary=${boundary}` });
            const endpoint = fileId
                ? `${GOOGLE_DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,modifiedTime,size`
                : `${GOOGLE_DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,modifiedTime,size`;
            return GoogleDriveBackup.fetchJson(endpoint, {
                method: fileId ? 'PATCH' : 'POST',
                headers: {
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body
            });
        },

        uploadBackup: async (text) => {
            if (new Blob([text]).size > 5 * 1024 * 1024 - 4096) {
                throw driveFailure('バックアップが5MBを超えています。ファイルへのバックアップ出力をご利用ください。');
            }
            const folder = await GoogleDriveBackup.ensureFolder();
            const existing = await GoogleDriveBackup.findBackupFile(folder.id);
            const file = await GoogleDriveBackup.uploadMultipart(existing?.id || null, folder.id, text);
            const readback = await GoogleDriveBackup.readFile(file.id);
            if (readback !== text) throw driveFailure('Google Driveへの保存内容を確認できませんでした。保存先のデータをご確認ください。');
            return { folder, file, updated: !!existing };
        },

        readFile: fileId => GoogleDriveBackup.request(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {}, true),

        downloadBackup: async () => {
            const folder = await GoogleDriveBackup.findFolder();
            if (!folder) throw driveFailure('選択したGoogleアカウントに、こもれび記録のバックアップがありません。');
            const file = await GoogleDriveBackup.findBackupFile(folder.id);
            if (!file) throw driveFailure('選択したGoogleアカウントに、こもれび記録のバックアップがありません。');
            return { text: await GoogleDriveBackup.readFile(file.id), file, folder };
        }
    };


    global.addEventListener('pagehide', () => {
        GoogleDriveBackup.clearSession();
        const pending = GoogleDriveBackup.pendingAuthorization;
        if (pending) {
            clearTimeout(pending.timer);
            GoogleDriveBackup.pendingAuthorization = null;
            pending.reject(driveFailure('Google Driveへの接続を中止しました。'));
        }
        GoogleDriveBackup.tokenClient = null;
    });
    global.KomorebiDrive = Object.freeze({
        isConfigured: GoogleDriveBackup.isConfigured,
        isReady: () => !!GoogleDriveBackup.tokenClient,
        prepare: GoogleDriveBackup.ensureTokenClient,
        authorize: GoogleDriveBackup.authorize,
        clearSession: GoogleDriveBackup.clearSession,
        uploadBackup: GoogleDriveBackup.uploadBackup,
        downloadBackup: GoogleDriveBackup.downloadBackup
    });
})(window);
