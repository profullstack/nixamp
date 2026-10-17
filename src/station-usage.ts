/** `nixamp station` usage, apart so `nixamp help station` does not load the client. */
export const USAGE = `nixamp station — make a collection into a station

  nixamp station list
  nixamp station create --name NAME (--folder PATH | --playlist ID | --items 0,1,2) [--shuffle] [--no-repeat] [--bitrate 128]
  nixamp station show ID
  nixamp station status ID
  nixamp station start ID
  nixamp station stop ID
  nixamp station skip ID
  nixamp station retry ID          try every left-out file again
  nixamp station publish ID --basis owned|permission|licensed|public-domain [--note TEXT] [--unlisted] [--no-list]
  nixamp station unpublish ID [--private]
  nixamp station link ID [--rotate]
  nixamp station delete ID

  --json        machine-readable output
  --url, --key  another server, as with \`nixamp admin\`

A new station is private and stopped. Starting it does not publish it.`;
