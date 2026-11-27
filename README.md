# Exact Social

A native social post planner built with [Exact](https://github.com/expo/exact). The first slice is a queue of post drafts, a compose sheet, and drafts kept on the device.

Nothing in this slice schedules or publishes. A draft can name channels and carry a planned day and time; both are notes on the draft, and the screens say so. A planned day that has gone by is marked Past, never as sent.

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

- `app.contract`: the view. `App` is the queue and owns the data; `Composer` is the sheet for a new draft or the row tapped.
- `app.ts`: the data module. It keeps drafts in `app:/data/drafts.json` and answers the queue grouped and ordered: drafts with no day first, then each planned day in turn.
- `channels.ts`: the channels a draft can name, and the seam for an account connection. `listChannels` answers a fixed local list today; a Postiz connection can answer connected accounts with the same fields (`id`, `name`, `limit`). A draft stores channel ids only.
- `app.test.contract`: the tests, driven by `testId` on every host.
- `lib/`, `tools/`, `research/`: the Postiz read adapter and the research brief. The UI does not import them yet.

## What the UI does not do yet

Attach media, connect an account, schedule, publish, or show sent posts. The compose sheet has no per-channel text or settings. The Mac's software keyboard setting hides the simulator keyboard in some captures; the layout under a keyboard was checked only where the capture showed it.
