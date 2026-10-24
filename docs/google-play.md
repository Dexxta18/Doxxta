# Publishing Doxxta on Google Play

What's ready in this repository, and the steps that need your Google account.

## What's ready

- **The app bundle.** Google Play takes an Android App Bundle (`.aab`), not an APK. The **Installers** workflow builds `Doxxta-<version>.aab` and attaches it to the release once your signing key is in the repository's secrets (step 2); without the key it skips the bundle, since Play won't take one signed with a throwaway key.
- **The store listing**, in `fastlane/metadata/android/en-US/`:
  - `title.txt`, `short_description.txt`, `full_description.txt`: the name and descriptions (within Play's 30, 80 and 4,000 characters).
  - `changelogs/500.txt`: the release notes for version 0.5.0 (version code 500).
  - `images/icon.png` (512 × 512), `images/featureGraphic.jpg` (1024 × 500) and `images/phoneScreenshots/` (six, 1080 × 1920).
  - `node scripts/store-graphics.mjs` makes the images again after the app changes, from the demo documents it creates.
- **The privacy policy**: [PRIVACY.md](../PRIVACY.md), at https://github.com/Dexxta18/Doxxta/blob/main/PRIVACY.md.
- **What Play requires of the app itself.** It targets Android 16 (API level 36), which new apps need, and asks for one permission: internet access.

## 1. Create a developer account

Sign up at [play.google.com/console](https://play.google.com/console). It costs a one-time $25 and needs an ID check, which can take a few days.

- **Personal account** (an individual): before the app can go public, it must be tested by at least 12 people who stay signed up as testers for 14 days in a row (step 6).
- **Organization account** (a registered business, with a D-U-N-S number): skips that test.

The contact email you give for the app is shown on its store page, so use one you're happy to share.

## 2. Put the signing key in GitHub

`doxxta-android-signing.txt`, sent with `doxxta-release.jks` when the phone apps were first released, lists four secrets and their values. On GitHub, go to **Settings → Secrets and variables → Actions → New repository secret** and add each one: `ANDROID_KEY_ALIAS`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` and `ANDROID_KEYSTORE_BASE64`.

This key becomes your *upload key*: Google signs the copy of the app that Play delivers with its own key, and checks that each bundle you upload is signed with yours. Keep the two files and the passwords backed up somewhere private. If they're ever lost, Play's support can reset the upload key.

## 3. Build the bundle

In **Actions → Installers → Run workflow**, keep **Publish a release** ticked and run it. When it finishes, the release has `Doxxta-<version>.aab` next to the other downloads. The `.aab` is only for uploading to Play; phones can't install it.

## 4. Create the app in Play Console

**Create app**: app name **Doxxta: PDF Editor & Reader**, default language English (United States), App, Free (a free app can't later become paid), and accept the declarations.

**Grow users → Store presence → Main store listing**: paste the title and the two descriptions from `fastlane/metadata/android/en-US/`, and upload the icon, the feature graphic and the six phone screenshots, in order.

**Store settings**: category **Productivity**, tags about PDFs and documents, your contact email, and optionally the website `https://github.com/Dexxta18/Doxxta`.

## 5. App content

In **Policy and programs → App content**:

| Section | Answer |
| --- | --- |
| Privacy policy | `https://github.com/Dexxta18/Doxxta/blob/main/PRIVACY.md` |
| Ads | No ads |
| App access | All functionality is available without special access (there's no sign-in) |
| Content rating | Fill in the questionnaire with the category for utility and productivity apps, and answer **No** to every question about content (violence, sexuality, language, drugs, gambling, user interaction, sharing location, purchases). Doxxta can download a PDF from a web address you enter, but it isn't a web browser. Expect a rating of Everyone / PEGI 3. |
| Target audience | 13 and over (ticking an age under 13 brings in the policies for children's apps) |
| Data safety | **No**: the app doesn't collect or share any of the listed user data. Documents are edited on the phone and never uploaded; there are no accounts, ads, analytics or tracking. The listing then says "No data collected" and "No data shared". |
| Advertising ID | No, the app doesn't use it |
| News app, government app, financial features, health | No / None |

## 6. Closed test (personal accounts)

1. **Testing → Closed testing**: create a track, and under **Testers** add an email list with the Google account addresses of at least 12 people.
2. **Create new release**: when asked about app signing, keep **Let Google manage and protect your app signing key**. Upload the `.aab` from step 3, paste `changelogs/500.txt` as the release notes, and **Start rollout**. Google reviews it, which takes from a few hours to a few days.
3. Copy the test's opt-in link and send it to your testers. Each one opens it, taps **Become a tester**, then installs Doxxta from the Play Store link on that page. People who don't opt in don't count.
4. Keep at least 12 testers signed up for 14 days in a row: if the count drops below 12, the 14 days start again. Ask them to really use the app, since Google asks about the test afterwards.
5. After the 14 days, **Dashboard → Apply for production** and answer the questions about the test. Google's answer can take up to a week.

## 7. Release to everyone

In **Production → Create new release**, add the same bundle from the library (or a newer one), choose the countries, and roll it out. After a last review, Doxxta is on Google Play.

## Updates

Raise the version in `package.json`, run the Installers workflow, and upload the new `.aab` in a new Production release. The version code rises with the version (0.5.1 is 501), as Play requires.

The copy on Play and the APK on GitHub are signed with different keys (Google's and yours), so a phone can't update one with the other: it has to uninstall first. Once Doxxta is on Play, send people there.

From 2027, Android phones will only install apps from verified developers, including apps from outside Play such as the GitHub APK. Your Play Console account is that verification; see [Android developer verification](https://developer.android.com/developer-verification/guides) for registering an app you also share outside Play.
