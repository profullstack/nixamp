# BitTorrented → Nixamp handoff

PRD section 10. BitTorrented keeps its collections and downloads; Nixamp keeps what it is handed.

## Who may hand over

`POST /api/v1/integrations/bittorrented/handoffs` on a Nixamp server (the person's own,
self-hosted) accepts the control key, the owner's nixamp.com session, or an OAuth access token
from an app the owner granted the **`stations`** scope. Since 0.34.0:

- `GET https://nixamp.com/api/v1/auth/me` reports `grant: {clientId, scope}` for an OAuth token,
  and a server refuses an OAuth token as its owner unless the grant includes `stations`.
- `GET https://nixamp.com/api/v1/servers` needs `streams` or `stations` from an OAuth token and
  never returns a server's control key to one; an app may not add or change servers.

## Request (version 1)

```json
{
  "version": 1,
  "idempotencyKey": "bt:<user>:<sha256 of host + files>",
  "name": "Late Night",
  "source": { "torrentId": "...", "infohash": "...", "collectionId": "..." },
  "files": [
    {
      "fileId": "<bt_torrent_files.id>",
      "name": "01 Song.mp3",
      "size": 8123456,
      "mediaType": "audio/mpeg",
      "complete": true,
      "url": "https://bittorrented.com/api/v1/nixamp/files/<grant>",
      "expiresAt": 1792300000000,
      "metadata": { "title": "Song", "artist": "Band", "album": "LP", "track": 1 }
    }
  ]
}
```

- `url` is a grant for **one file, one audience, until `expiresAt`**; https only; every
  redirect hop must resolve to a public address.
- At most 500 files, 4 GiB each, audio by type or extension.
- `201 {handoff, created: true}`, or `200 {handoff, created: false}` for a key already used by
  the same owner: a retry never makes a second handoff or station.

## What Nixamp does

1. Makes a **private, stopped station draft** with every file's eventual path. Publishing and
   starting are separate, explicit steps.
2. Copies each file (two at a time) into `$XDG_STATE_HOME/nixamp/imports/bittorrented/<handoff>/`,
   a managed library source, so a station never depends on peers. The copy must be exactly
   `size` bytes; its SHA-256 is recorded.
3. Probes each copy; only `ready` files play. BitTorrented's tags fill in where the file has none.

File states: `pending`, `downloading`, `ready`, `failed` (after 3 attempts, reason kept),
`expired` (the link ran out, or BitTorrented answered 401/403/410), `unsupported`.
Handoff status: `importing`, `ready`, `partial`, `failed`. Grant links are never shown back.

| | |
| --- | --- |
| `GET /api/v1/integrations/bittorrented/handoffs` | the owner's handoffs |
| `GET .../handoffs/:id` | status per file |
| `POST .../handoffs/:id/retry` | `{files: [{fileId, url, expiresAt}]}` new links; failed and expired files are tried again |
| `DELETE .../handoffs/:id` | **removes the copies this handoff made** (and nothing else); the station loses those files |

## Retention

Removing or losing the item in BitTorrented does not touch the copy on the Nixamp server.
Deleting the handoff on the Nixamp server is the one Nixamp action that deletes files, and only
its own copies. Removing the imports source from the library forgets the items but leaves the files.
