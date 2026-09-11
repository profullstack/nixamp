# Amazon submission and sideloading

## The app file

Upload this signed binary in **Step 1: Upload your app file**:

`backtoschoolhelp-release.apk`

Do not upload the Appstore artwork ZIP in the binary field. The artwork files
belong in **Step 3: Appstore details**.

The APK has package ID `help.backtoschool.tv`, version code `1`, version name
`1.0.0`, minimum API 22, target API 36, an Android launcher, and a Fire TV
Leanback launcher.

## Targeting

After Amazon analyzes the APK, open **Target your app**, edit supported devices,
and select the Fire TV devices you intend to support. The manifest declares
touchscreen and fake touch as optional so Amazon can classify the binary for
Fire TV. It also remains usable on Fire tablets.

## Listing artwork

Use the exact filename map in:

`../public/assets/backtoschool-amazon-appstore/README.md`

Use the title, descriptions, feature bullets, and keywords in:

`../public/assets/backtoschool-amazon-appstore/LISTING-COPY.md`

## Sideloading

Install a downloaded build on a Fire TV connected through ADB:

```sh
adb install -r backtoschoolhelp-release.apk
adb shell am start -n help.backtoschool.tv/.MainActivity
```

## Hosting the APK

Stage the signed release into the BackToSchool web build:

```sh
./backtoschool-firetv/stage-release.sh /path/to/backtoschoolhelp-release.apk
```

After deploying `backtoschool/dist`, the file is available at:

`https://backtoschool.help/backtoschoohelp.apk`

The download is for direct testing and sideloading. Amazon customers should
normally install the reviewed build through the Amazon Appstore.
