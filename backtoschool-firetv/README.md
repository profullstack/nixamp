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

The GitHub Actions workflow generates the first release key, signs the APK,
validates it, and returns separate APK and signing-key artifacts. Preserve that
key permanently: every future Amazon Appstore update must use the same key.

Immediately after the first build, download the one-day signing-key artifact
and configure these repository secrets before another release build:

- `BACKTOSCHOOL_RELEASE_KEYSTORE_BASE64`
- `BACKTOSCHOOL_RELEASE_KEYSTORE_PASSWORD`
- `BACKTOSCHOOL_RELEASE_KEY_PASSWORD`

Create the first value with `base64 -w0 backtoschool-release.p12`. The alias is
always `backtoschool`.

See `SUBMISSION.md` for the exact Amazon upload field, Fire TV targeting,
sideloading, and the `backtoschool.help/backtoschoohelp.apk` staging flow.
