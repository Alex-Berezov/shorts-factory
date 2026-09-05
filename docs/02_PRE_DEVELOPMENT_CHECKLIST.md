# Pre-Development / Launch Checklist — Multilingual Shorts Project

_Last updated: 2026-09-05_

This checklist now reflects the real state of the channel and the discoveries made during YouTube setup.

Legend:
- ✅ completed
- 🟡 in progress / external dependency
- ⬜ to do

---

## A. Google / YouTube account setup

### A1. Use the existing personal Google Account — ✅ accepted

A separate Google Account is **not required**.

The current plan is to manage the new brand channel from the existing personal Google Account. This is acceptable because YouTube allows one Google account to manage multiple channels.

Security recommendation:

- keep 2-Step Verification enabled on the Google account;
- do not share the Google password with future collaborators;
- if collaborators are added later, use YouTube permissions/channel access instead.

### A2. Create the project YouTube channel — ✅/name still being finalized

The channel can be created under the existing Google Account with its own:

- display name;
- handle;
- avatar;
- banner;
- channel identity.

Do not finalize visual branding yet. The name/handle should be clean and global.

---

## B. Feature verification

### B1. Phone verification / Intermediate Features — ✅ completed

Current state:

- phone verification succeeded;
- **Intermediate Features = Enabled**.

Path to verify status:

1. Open **YouTube Studio** on desktop.
2. Bottom-left -> **Settings**.
3. Select **Channel**.
4. Open **Feature eligibility**.
5. Confirm **Intermediate features — Enabled**.

Official reference:
https://support.google.com/youtube/answer/171664

### B2. Advanced Features — 🟡 waiting for Channel History

Current state:

- **Advanced Features = Eligible**;
- requirement shown by YouTube: **Channel history**;
- ID verification is not offered;
- video verification is not offered;
- direct Google verification pages report that advanced YouTube verification is **unavailable in the current location**.

Therefore, no further ID/video action is possible at the moment.

Do **not** block development on this.

YouTube states that active channels that consistently follow Community Guidelines can typically build sufficient channel history within roughly two months. This is not a fixed guarantee.

Check status periodically:

**YouTube Studio -> Settings -> Channel -> Feature eligibility -> Advanced features**

Goal:

> Advanced features — Enabled

Official reference:
https://support.google.com/youtube/answer/9891124

---

## C. Automatic Dubbing — ✅ feature already available

This was an important discovery.

Current channel path:

**YouTube Studio -> Settings -> Channel -> Advanced settings -> Automatic dubbing**

Current observed settings:

- ✅ **Allow automatic dubbing**
- ✅ **Manually review dubs before publishing**
- current review mode observed: **experimental languages only**

### Recommended test-phase setting

For the first few Shorts, change review mode to:

> **Review dubs in all languages**

Reason: we want to inspect actual translation/voice quality before allowing YouTube to publish dubs automatically.

Official reference:
https://support.google.com/youtube/answer/15569972

### Important behavior

- YouTube creates dubbed audio automatically for eligible videos/languages.
- Viewers can switch between original and dubbed tracks.
- Dubs can be previewed, published/unpublished or deleted.
- Automatic dubs cannot be directly edited.
- Quality can vary by language.
- Properly setting the original language is important.

---

## D. Canonical language — ✅ decision made

Set **English** as the canonical/master language for the project.

Why:

- master scripts will be produced in English;
- initial Shorts will be published with English narration;
- YouTube Auto Dubbing can use English as the source language;
- future custom localization can branch from the same canonical version;
- English remains the cleanest common source layer for a 10–20-language pipeline.

### Set English as upload default where appropriate

In YouTube Studio:

1. Open **Settings**.
2. Open **Upload defaults**.
3. Set the default video language/original language to **English** where the UI allows it.
4. For every real upload, verify the video's original language is English.

---

## E. First real YouTube smoke test — ⬜ next action

Do **not** upload meaningless test content if avoidable. Use a simple but real Short in the future channel format.

### E1. Create one English Short

Recommended:

- ~20–45 seconds;
- clear English narration;
- no copyrighted background content that could trigger claims;
- normal speaking pace;
- simple hook + story + payoff;
- valid vertical Short format.

### E2. Upload it

1. YouTube Studio -> **Create -> Upload videos**.
2. Upload the English master.
3. Set original language to **English**.
4. Complete metadata.
5. Publish or schedule.

### E3. Wait for dubbing processing

After processing:

1. Open **YouTube Studio**.
2. Open **Content**.
3. Select the Short.
4. Open **Languages**.
5. Inspect which dubs were generated.
6. Preview several languages, especially:
   - German
   - Spanish
   - French
   - Portuguese
   - Italian
   - Polish
   - Japanese/Korean if offered
7. Note quality problems:
   - names;
   - idioms;
   - timing;
   - emotional tone;
   - pronunciation;
   - unnatural sentence structure.

### E4. Record the result

Create a simple temporary test table:

| Language | Generated? | Voice quality | Translation quality | Timing | Publish? | Notes |
|---|---|---|---|---|---|---|

This becomes the first benchmark for later comparison with ElevenLabs/Gemini/Cartesia/custom localization.

---

## F. Build channel history while developing — ⬜ ongoing

Recommended temporary cadence while the app is not ready:

- **4–7 real English Shorts/week**;
- ideal if sustainable: ~1/day;
- do not force 2/day yet;
- quality and learning matter more than volume during this phase.

Purpose:

1. Build YouTube channel history.
2. Generate first real analytics.
3. Learn the actual manual CapCut workload.
4. Test Auto Dubbing.
5. Seed the future Experiment Engine dataset.

For every manually produced Short, record at least:

- working title;
- topic/subtopic;
- hook type;
- duration;
- opening visual type;
- reveal timing;
- publish date;
- URL/video ID.

Later import this into the app.

---

## G. Manual Multi-Language Audio — 🟡 test when Advanced Features unlock

Official YouTube documentation says Multi-Language Audio is available to creators with Advanced Features.

When **Advanced Features = Enabled**:

1. Open YouTube Studio on desktop.
2. Open **Languages**.
3. Select an existing Short.
4. Click **Add language**.
5. Select a language.
6. Find **Dub -> Add**.
7. Upload a custom audio track.
8. Test at least German and Spanish.
9. Verify the viewer can switch audio tracks.

Important:

- if YouTube has already generated an automatic dub for that language, delete the automatic dub before uploading your own custom version.

Official reference:
https://support.google.com/youtube/answer/13338784

Decision gate:

- If manual custom dub upload works -> keep one-channel/20-language architecture.
- If unavailable even after Advanced Features -> continue using Auto Dubbing while investigating rollout/eligibility; do not immediately split into 20 channels.

---

## H. Google Cloud / API preparation — ⬜ do during app development

### H1. Create Google Cloud Project

1. Open Google Cloud Console.
2. Create a new project specifically for the application.
3. Give it a neutral app/project name; it does not need to match the final channel name.

### H2. Enable APIs

Enable:

- **YouTube Data API v3**
- **YouTube Analytics API**

Later enable any additional Google APIs only if required.

### H3. Configure OAuth

Create OAuth credentials for the application so it can read private analytics for the owned channel.

Store secrets only in environment variables / secure secret storage. Never commit them to Git.

### H4. Initial API smoke tests

Verify the app can:

- read our channel identity;
- read our uploads;
- read public competitor metadata;
- collect public video statistics;
- query owned-channel Analytics API metrics after there is data.

---

## I. Gemini whole-video analysis test — ⬜ required before building Video Intelligence

Gemini API supports public YouTube URLs as video input.

Run a representative competitor Short through Gemini and request structured output containing:

- story summary;
- semantic transcript;
- 0–5s hook analysis;
- visual timeline;
- narration timeline;
- reveal timing;
- emotional driver;
- editing/visual rhythm estimate;
- transferable Content DNA;
- what should not be copied literally.

Then manually inspect whether the result is good enough.

If needed, add a second high-detail pass focused on the first 5 seconds.

Official reference:
https://ai.google.dev/gemini-api/docs/video-understanding

---

## J. TTS bake-off — ⬜ later, not a blocker now

Because YouTube Automatic Dubbing is already available, custom TTS is no longer required for the first live test.

Before committing to a custom provider, compare the same scripts in multiple languages using:

- ElevenLabs
- Gemini TTS
- Google Chirp 3 HD
- Cartesia Sonic
- OpenAI TTS
- YouTube Auto Dub as the baseline

Score:

- naturalness;
- emotion;
- pronunciation;
- multilingual consistency;
- timing control;
- API ergonomics;
- cost.

---

## K. Development go/no-go status

### Current conclusion: **GO**

We no longer need to wait for Advanced Features.

Confirmed enough to begin:

- ✅ channel exists / can be operated from existing Google Account;
- ✅ phone verified;
- ✅ Intermediate Features enabled;
- ✅ Automatic Dubbing available;
- ✅ English chosen as master language;
- ✅ official Multi-Language Audio path exists for Advanced Features;
- ✅ Gemini can analyze public YouTube URLs;
- ✅ YouTube Data + Analytics APIs cover the core dashboard use case.

External dependency to monitor:

- 🟡 Advanced Features / Channel history;
- 🟡 manual custom Multi-Language Audio test after unlock.

Immediate next action:

> **Publish the first real English Short and inspect YouTube's generated auto-dubs.**
