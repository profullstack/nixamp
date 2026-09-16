# BackToSchool.help for Fire TV

This Android app is a locked-down Fire TV and Fire tablet shell for
`https://backtoschool.help/`. It does not expose an address bar or permit
navigation to arbitrary sites.

## Compatibility

- Application ID: `help.backtoschool.tv`
- Minimum API: 22 (Fire OS 5)
- Target and compile API: 36
- Launchers: Android and Fire TV Leanback
- Touchscreen, fake touch, microphone, camera, and Leanback are optional
- Cleartext HTTP is disabled

## Classroom playback

Classrooms play Nixamp shares and HTTPS media URLs directly in a video element
using `@profullstack/player`; no player page is loaded in an iframe. Nixamp video
channels use HLS, with the viewer key carried on playlists and segments. The
source server must allow browser access from BackToSchool for HLS playback.

D-pad presses navigate visible controls. Play/pause, rewind and fast-forward
keys control the active broadcast. Full screen expands the player inside the
WebView, keeping the controls available; Back exits it before navigating away.
Player connections are released when leaving the classroom. Web changes require
a site deployment; native media-key forwarding requires rebuilding the APK.

Pairux live/join URLs do not expose a direct stream through their embed page.
They show an explanation on TV and an external viewing link in other browsers.
Hosts need a Nixamp share or direct media URL for inline TV playback. Pairux
WebRTC session integration is not implemented by this client.

For a desktop remote-navigation check, open the site with `?tv=1`, enter a class,
and use arrow keys and Enter. Check play/pause, seek on recordings, mute, full
screen, Back/Escape, and leaving the class while playback is loading. A physical
Fire TV smoke test is still required before distributing a rebuilt APK.

## Build

Release builds require the four signing environment variables used in
`app/build.gradle.kts`. Never commit the release keystore or its password.

```sh
BACKTOSCHOOL_KEYSTORE_PATH=/secure/backtoschool-release.p12 \
BACKTOSCHOOL_KEYSTORE_PASSWORD=... \
BACKTOSCHOOL_KEY_ALIAS=backtoschool \
BACKTOSCHOOL_KEY_PASSWORD=... \
./gradlew lintRelease assembleRelease
```

The GitHub Actions workflow signs app updates using the original release key.
Configure these repository secrets before building:

- `BACKTOSCHOOL_RELEASE_KEYSTORE_BASE64`
- `BACKTOSCHOOL_RELEASE_KEYSTORE_PASSWORD`
- `BACKTOSCHOOL_RELEASE_KEY_PASSWORD`

The first is the base64-encoded original PKCS12 keystore. The alias is
`backtoschool`. Keep a secure backup of the original key and passwords; a newly
generated key cannot sign a compatible update for existing installs. The
workflow fails if these secrets are missing instead of silently replacing the key.

To attach an APK to an existing GitHub release, dispatch the workflow with
`release_tag` set to that tag. With no tag, it only uploads a build artifact.

See `SUBMISSION.md` for the exact Amazon upload field, Fire TV targeting,
sideloading, and the `backtoschool.help/backtoschoohelp.apk` staging flow.
