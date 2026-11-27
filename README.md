# Exact Social

A native publishing client for a self-hosted [Postiz](https://postiz.com) workspace, built with [Exact](https://github.com/expo/exact). It is iPhone first. Your accounts, posts and media stay on your own Postiz; the app is the place you write, schedule and review.

## What it does

- **Publish.** The queue, the drafts and the sent posts of the workspace, by day. Filter by one account. Switch to a week calendar and move by week. Pull down to refresh.
- **Compose.** Accounts are a row of avatars at the top: tap one to include it, tap it again to leave it out. Attach photos and videos. The count follows the account with the shortest limit.
- **Network settings.** Each chosen network shows the settings your Postiz advertises for it (Instagram Post, Reel or Story, collaborators, who can reply on X, TikTok privacy). Required settings show first.
- **Finalize.** Schedule for a day and a time, publish now, or save a draft. The app says what blocks a post before it sends anything (a missing photo, a text over the limit, a required setting).
- **Review.** One card for each account, as it will be sent. One account can take its own text.
- **Drafts.** A draft that names an account is saved to Postiz, so other clients see it. A draft with no account stays on the device.
- **Templates.** Text you write again and again, kept on the device. Start a post from one.

## Connect your Postiz

In your Postiz workspace, open **Settings → Public API** and copy the workspace API key. In Exact Social, open **Accounts → Connect Postiz** and enter the HTTPS address you normally open Postiz at, such as `https://postiz.example.com`, and the key. Exact Social checks the key against the public API and reads the workspace name. Provider sign-in and authorization are managed in Postiz.

Exact Social keeps the key in the Apple Keychain on iPhone and in the app origin's local storage on the web. It keeps the instance address and workspace name in `app:/data/postiz-connection.json`. Disconnect clears the saved connection. Posts and uploaded media stay in Postiz. The device keeps an index of post IDs created together because the public calendar exposes a different Postiz group for each destination.

Postiz accepts Instagram `post` and `story` as API values. A single MP4 with `post` goes to Instagram as a Reel, so Exact Social offers Reel as a format and sends the corresponding Postiz value. Postiz validates provider settings for remote drafts too. Drafts with no destination selected stay on the device. Exact Social uploads device files up to 16 MB. For larger files, upload in Postiz and reuse the existing attachment from a Postiz post.

The schedule and draft paths send the chosen timestamp as UTC with milliseconds. With **Publish Now**, Postiz starts its publishing workflow and chooses the server's current minute. If a write times out or confirms only some destinations, check the queue before retrying. A confirmed destination means Postiz accepted it. Provider delivery status appears in the calendar once Postiz updates it.

## Run

The app uses the sibling `../expo-exact` checkout by path (`EXACT2` overrides it).

```sh
bun run dev               # web with a local Postiz fixture
bun run dev ios --run     # iOS simulator with the same fixture
bun run build             # web release build, starts disconnected
```

The dev command starts a Bun fixture on `http://127.0.0.1:4786` and shuts it down with the app command. Development builds default to this address (`POSTIZ_DEV_URL` in `app.json`) and start connected to **Demo** on first launch. The development key `exact-social-dev` belongs to that fixture only. Set `POSTIZ_DEV_URL=off` to test a fresh, disconnected development build. Release builds also remove the development HTTP grants. To run Exact directly against the fixture, start `bun server.ts` in another terminal.

## Web proxy for separate origins

The native app calls a self-hosted Postiz instance directly over HTTPS. A web deployment on a different origin needs that origin allowed by Postiz or an HTTPS proxy. The self-hosted instance checked for this integration returned `204` and allowed the authorization header on preflight, but omitted `Access-Control-Allow-Origin` for a separate origin. Its own frontend origin received the header. Postiz defines the origins in its [backend CORS configuration](https://github.com/gitroomhq/postiz-app/blob/main/apps/backend/src/main.ts).

The included Bun proxy uses a single administrator-configured Postiz upstream and a single web app origin. Run it beside your TLS reverse proxy.

```sh
POSTIZ_UPSTREAM=https://postiz.example.com APP_ORIGIN=https://social.example.com bun server/proxy.ts
```

Forward an HTTPS hostname such as `https://postiz-api.example.com` to `127.0.0.1:4787` (override with `PORT`). Preserve the request path, pass the `Authorization` header, allow request bodies up to 64 MB, and keep authorization headers out of reverse-proxy logs. Enter the proxy HTTPS address in Exact Social's **Connect Postiz** form with your workspace key. The proxy forwards the key request by request and leaves media at its upstream URL. Users' browsers and providers must be able to reach those URLs.

## Verify

```sh
bun test
bun exact.mjs test
bun exact.mjs verify
bun exact.mjs verify ios
```

Exact starts its own fixture with a scratch SQLite database for tests and verification. Stop a manually started fixture before running either command. The fixture seeds six accounts and the initial calendar when it receives its first API request. Contract tests that inspect current posts use `epoch now` to match that calendar.

The fixture-only control route `POST /__postiz/fault` accepts `{"kind":"timeout","path":"/posts","delayMs":16000}`. Supported kinds are `fail`, `timeout`, `partial`, and `invalid`. It applies to the next matching request. Omit `path` to match any eligible request, and omit `delayMs` to use the timeout default. For a partially acknowledged write, the fixture saves and acknowledges the first destination.

## Layout

- `app.contract`: the root. It holds every resource and the post being composed, and draws each screen as a route: Publish, the post sheet, the composer and its sheets (finalize, review, drafts, templates), Templates, Accounts and the connection form.
- `parts.contract`: drawn parts (an avatar with its network mark, a post card, a media tile). `shapes.contract`: the shapes the view and the data module agree on.
- `app.tamber`: the design. Colours for light and dark, and the network icons under `assets/icons` (from [Simple Icons](https://simpleicons.org), CC0).
- `app.ts`: the data module's entry and its grants. `data/postiz*.ts` is the Postiz client; `data/local.ts` keeps device drafts, templates and picked media, and reads a day and a time as an instant in the device's time zone.
- `server.ts`, `server/`: the local Postiz fixture for development and tests, and the web proxy.
- `app.test.contract`, `postiz.test.contract`, `postiz.test.ts`: the tests.

## Limits

- An attachment from the device can be 16 MB at most. A larger video must be uploaded in Postiz first.
- Publishing to live accounts and Reel delivery were not exercised against a real workspace. Reads, uploads, draft creation, draft edit and delete were.
- Insights and community replies are not built.
- On the web host, a sheet can stay painted after a post is sent from the finalize sheet. The iPhone app closes both sheets.
