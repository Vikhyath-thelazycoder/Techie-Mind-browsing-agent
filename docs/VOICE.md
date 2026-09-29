# Voice and languages

Phase 7 (spec §44–45). Spoken and typed requests use the **same** pipeline:
speech-to-text → task understanding → execution → spoken reply. Language never changes security
policy.

## Speaking to the agent

- Click the **mic** in the side panel. Speak, then click the mic again to finish. A local recording
  also stops by itself after 12 s.
- The **language button** next to the mic (EN / HI / KN / TA / TE) sets the recognition language.
- The **speaker button** turns spoken replies on or off. A reply is a short status line in your
  language plus the key detail.

### Engines (Settings → AI & Models → Voice & Audio)

| Engine | Where audio goes | Setup |
|---|---|---|
| **Local Whisper** (default) | Only to a whisper.cpp server on this Mac (loopback) | See below |
| Chrome Web Speech | Chrome sends the audio to **Google** | Tick the consent box. Until then it is not used |

Local Whisper on a Mac:

```bash
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build && cmake --build build -j --config Release
sh ./models/download-ggml-model.sh small      # multilingual; "medium" is more accurate
brew install ffmpeg                           # --convert needs it (the side panel records webm)
./build/bin/whisper-server -m models/ggml-small.bin --host 127.0.0.1 --port 8178 --convert
```

The default URL is `http://127.0.0.1:8178/inference`.

**Microphone permission:** Chrome cannot show the microphone prompt inside the side panel. Press
**Allow microphone** once in Settings → Voice & Audio; the permission then applies to the side
panel.

## Languages and code-switching

Typed or spoken requests in English, Hindi, Kannada, Tamil and Telugu work in native script and in
romanized form:

| Say | Same as |
|---|---|
| Kannada songs play maadi · ಯೂಟ್ಯೂಬ್‌ನಲ್ಲಿ ಕನ್ನಡ ಹಾಡುಗಳನ್ನು ಪ್ಲೇ ಮಾಡಿ | play Kannada songs on YouTube |
| Flipkart alli running shoes search maadu | search running shoes on Flipkart |
| Amazon pe black shoes dhoondo · अमेज़न पर काले जूते ढूंढो | search black shoes on Amazon |
| फ्लिपकार्ट पर ₹50,000 से कम लैपटॉप ढूंढो · flipkart pe 50000 se kam laptop dhoondo | laptops under ₹50,000 on Flipkart |
| सबसे सस्ता वाला खोलो · ಅಗ್ಗದ ಫೋನ್ ತೆರೆ | open the cheapest one |
| वापस जाओ · ಹಿಂದೆ ಹೋಗು · neeche scroll karo | go back · scroll down |
| कार्ट में डालो · इस पेज का सारांश दो | add to cart · summarize this page |
| யூடியூபில் தமிழ் பாடல்கள் ப்ளே பண்ணு · యూట్యూబ్‌లో తెలుగు పాటలు ప్లే చేయి | play Tamil / Telugu songs on YouTube |

How it works (`packages/agent-core/src/multilingual.ts`):

- Command words, site names and grammar particles are rewritten into the resolver's canonical
  vocabulary.
- What you want to find is kept exactly as written; YouTube and stores search in any script.
- The detected language is reported, and spoken replies use it.
