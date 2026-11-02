# こもれび記録（ブラウザ版）

添付の `komorebi-main.zip` のPWAアイコンと雰囲気を流用し、記録機能をHTML/CSS/JavaScriptで再構成した静的ブラウザアプリです。

## 主な機能

- 1週間単位の入力：AM/PMの活動、気分(0〜100)、1日のふりかえり、週目標2つの結果
- 月間カレンダー：選択日の週ごとに目標を2つ設定、日付クリックで同じ日次データを閲覧・編集
- 記録一覧：月フィルター、キーワード検索
- 自動保存：IndexedDBを主保存、localStorageを予備コピーとして二重化
- 端末内復元ポイント：一定時間ごとの自動世代保存＋手動作成
- バックアップ：JSON書き出し／読み込み（追加・更新 または 置き換え）
- CSV出力
- 永続ストレージ要求（対応ブラウザ）
- PWA/オフラインキャッシュ

## 起動

静的ファイルとしてWebサーバーに配置してください。ローカル確認なら、このフォルダで例として次を実行します。

```bash
python3 -m http.server 8000
```

その後 `http://localhost:8000/` をブラウザで開きます。

> `file://` 直開きではブラウザによってIndexedDBやService Workerの挙動が異なるため、`localhost` または HTTPS 配信を推奨します。

## データ保持について

ブラウザ内保存だけでは、ブラウザデータ削除・端末故障・プロファイル消失には耐えられません。設定画面の「バックアップ出力」でJSONファイルを別の場所にも保管してください。

## v1.1 UI変更
- 初期表示を「カレンダー」に変更。
- スマートフォンでは下部固定の4タブナビゲーションに変更。
- カレンダーは横スクロールさせず、7列を必ず画面幅内に収める設計。
- スマートフォンではカレンダー内の長文要約を隠し、記録ドットと気分点数で密度を調整。
- 月間目標はカレンダー直下に配置し、まず月全体を見られる構成に変更。
- 薄い黄色をベースに、選択中タブは濃い黄色＋茶色文字へ変更。
- 週記録はスマートフォンで7日分を縦積みにし、横スクロールを避ける。

## v1.2 機能変更
- カレンダーの選択日編集パネルで、横フリック（左＝翌日、右＝前日）による日付移動に対応。
- 目標を月単位から週単位へ変更。日次の「目標結果」も、その日が属する週の目標に紐づきます。
- 設定画面で週の開始曜日を月〜日の任意の曜日に変更可能。週記録とカレンダーの曜日並びも同じ設定に連動します。
- 旧v1.1の月間目標データは、従来の週表示基準（週の中央日が属する月）に沿って週目標へ自動移行します。
- 週の開始曜日を変更した場合、既存の週目標は各週の中央日を基準に新しい週区切りへ引き継ぎます。


## v1.2.1
- カレンダーの日付フリックを1ジェスチャーにつき必ず1日だけ移動する方式に修正
- touchmove の preventDefault を廃止し、Chrome の Intervention 警告を解消
- 週目標見出しの改行と「目標を編集」ボタンの見た目を改善
- 「目標を編集」からカレンダー下部の週目標入力欄へ自動スクロール

## v1.2.2
- 設定画面に「アプリを更新」ボタンを追加。
- 更新時は IndexedDB / localStorage の記録データを残したまま、アプリ用 Cache Storage だけを最新版へ入れ替えます。
- 更新ファイルはすべて取得成功してからキャッシュを置き換えるため、通信失敗時は既存のオフラインキャッシュを保持します。
- Service Worker 自体の更新確認では HTTP キャッシュを使わないようにしました。

## v1.2.3
- 旧版利用者向けに `/life_diary/update.html` を追加。アプリ用キャッシュと Service Worker だけを整理し、記録データを残したまま最新版へ戻します。
- Service Worker が新版へ切り替わった場合、記録を保存してから画面を自動再読み込みするようにしました。
- `app.js` / `styles.css` に版番号付きURLを使い、更新直後に古いHTTPキャッシュを拾いにくくしました。

## アプリ更新について

通常起動時に Service Worker の更新を確認し、既存の Service Worker から新版へ切り替わった場合は、記録を保存してから自動で画面を再読み込みします。

旧版のキャッシュが強く残って更新できない端末では、`/life_diary/update.html` を一度開いてください。このページはアプリ用 Cache Storage と Service Worker だけを整理して最新版を開き直します。IndexedDB / localStorage の記録データは削除しません。

リリース時は `app.js` の `APP_VERSION` と `sw.js` の `CACHE_NAME` を更新してください。`index.html` と `sw.js` に付けている `app.js` / `styles.css` のバージョンクエリも同じ版へ合わせます。

## v1.3.0 配色とGoogle Driveバックアップ

- メインカラーは `#FFFF14`。背景、枠線、入力欄の強調もレモンイエロー系へ統一。
- 設定画面にGoogle Driveへの保存・読込を追加。記録・週目標・設定を既存のJSONバックアップ形式で扱います。
- 保存先は `マイドライブ / こもれび記録 Backups / komorebi-backup.json`。最新の1ファイルを明示操作で更新し、保存後に読み戻して一致を確認します。Prisma Abyssとは別のフォルダ・ファイル識別子を使用します。
- 読込は追加・更新または置き換えを選べます。同じ日付はバックアップを優先し、週の開始曜日の変更も既存のルールで引き継ぎます。読込前の復元ポイント、端末への保存と読み戻し、失敗時の差し戻しを行います。IndexedDBが使えない場合はlocalStorageへ読込前の状態を保管します。
- Google認証は保存・読込ボタンを押した時だけ開始します。要求権限は `drive.file` のみ。Gmail・メールアドレス・プロフィールは取得せず、アクセストークンは操作中のメモリだけに保持します。記録はブラウザーとGoogle Driveの間で直接送受信します。

### Google連携の有効化

現在はユーザーの希望により `index.html` の `google-drive-client-id` は空欄です。ボタンは無効で、Googleのライブラリ取得・認証・Drive通信も行いません。JSONファイルへの出力・読込は引き続き利用できます。

公開先を決めた後、Google CloudでDrive APIを有効にし、Web用OAuthクライアントの「承認済みのJavaScript生成元」に公開先のoriginを登録します。`https://yu-zora.com/life_diary/` なら登録する値は `https://yu-zora.com` です。Prisma Abyssと同じクライアントを使う場合も、このアプリのバックアップは固有のフォルダと識別子で区別します。

取得した公開クライアントIDを設定します。クライアントシークレットは不要です。

```html
<meta name="google-drive-client-id" content="取得した公開クライアントID.apps.googleusercontent.com">
```

HTTPS、または許可した開発用localhostで配信します。設定画面で認証ライブラリを準備し、保存・読込操作ごとにGoogleアカウントを選択します。認証拒否、キャンセル、通信失敗では勝手に再認証しません。Googleへの通信は30秒、認証準備は20秒、アカウント選択は120秒で打ち切ります。multipart方式のため、約5MBを超えるバックアップはJSONファイルへの出力をご利用ください。

設定の仕様は [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)、[OAuth Token Model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)、[Drive APIの権限](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)、[ファイルのアップロード](https://developers.google.com/workspace/drive/api/guides/manage-uploads)を参照してください。

### URLを移すときの記録の引き継ぎ

IndexedDBとlocalStorageは配信元ごとに分かれるため、別のoriginへ移しただけでは端末内の記録は自動表示されません。移行前のURLで「バックアップ出力」し、新しいURLでそのJSONを読み込むと引き継げます。旧URLでの出力を終える前に、ブラウザーの保存データを削除しないでください。

Google連携の有効化後は、同じGoogle OAuthクライアント・同じGoogleアカウントを使用し、新しい配信元もGoogle側の許可先に登録すると、Driveのバックアップから引き継げます。公開先を変える前にJSONファイルにも出力しておくと、Google設定に依存せず移せます。

### 検証

`node --test tests/backup.test.cjs` でGoogle認証・Drive通信を模擬した回帰検査を実行できます。実Googleアカウントでの送受信確認は、クライアントIDを設定した公開先で行います。
