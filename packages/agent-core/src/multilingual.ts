/**
 * Multilingual and code-switched requests (spec §44–45).
 *
 * Kannada, Hindi, Tamil and Telugu — in their own scripts or romanized — are rewritten into the
 * canonical command words the deterministic resolver already understands ("play maadi", "dhoondo",
 * "kholo", "go back", "under ₹N" …). Only command words, site names and a few grammar particles are
 * rewritten: what the user wants to find ("ಕನ್ನಡ ಹಾಡುಗಳು", "काले जूते") is kept exactly as written.
 *
 * Language never changes security policy: the rewritten request goes through the same router,
 * firewall and verification as an English one; the detected language is only reported.
 */

const B = '(?<![\\p{L}\\p{M}\\p{N}])';
const E = '(?![\\p{L}\\p{M}\\p{N}])';

/** Zero-width joiners appear inside Indic words ("ಫ್ಲಿಪ್‌ಕಾರ್ಟ್"); they never change meaning here. */
const ZERO_WIDTH = /[\u200b-\u200d\u2060]/gu;

/** Digits in Devanagari, Kannada, Tamil and Telugu → ASCII ("५०,०००" → "50,000"). */
const DIGIT_BLOCKS = [0x0966, 0x0ce6, 0x0be6, 0x0c66];

function asciiDigits(text: string): string {
  return text.replace(/[\u0966-\u096f\u0ce6-\u0cef\u0be6-\u0bef\u0c66-\u0c6f]/gu, (d) => {
    const code = d.codePointAt(0)!;
    const base = DIGIT_BLOCKS.find((b) => code >= b && code <= b + 9)!;
    return String(code - base);
  });
}

/** Site names written in Indic scripts. Replaced even with a case ending attached ("…ನಲ್ಲಿ"). */
const SITE_NAMES: ReadonlyArray<[string, string]> = [
  ['ಯೂಟ್ಯೂಬ್', 'youtube'],
  ['ಯೂಟ್ಯೂಬ', 'youtube'],
  ['ಫ್ಲಿಪ್ಕಾರ್ಟ್', 'flipkart'],
  ['ಅಮೆಜಾನ್', 'amazon'],
  ['ಅಮೇಜಾನ್', 'amazon'],
  ['ಗೂಗಲ್', 'google'],
  ['ವಿಕಿಪೀಡಿಯಾ', 'wikipedia'],
  ['यूट्यूब', 'youtube'],
  ['फ्लिपकार्ट', 'flipkart'],
  ['अमेज़न', 'amazon'],
  ['अमेज़ॉन', 'amazon'],
  ['अमेजन', 'amazon'],
  ['अमेजॉन', 'amazon'],
  ['गूगल', 'google'],
  ['विकिपीडिया', 'wikipedia'],
  ['யூடியூபில்', 'youtube alli'],
  ['யூடியூப்', 'youtube'],
  ['ஃப்ளிப்கார்ட்', 'flipkart'],
  ['அமேசான்', 'amazon'],
  ['அமேசானில்', 'amazon alli'],
  ['கூகுள்', 'google'],
  ['యూట్యూబ్', 'youtube'],
  ['ఫ్లిప్‌కార్ట్', 'flipkart'],
  ['ఫ్లిప్కార్ట్', 'flipkart'],
  ['అమెజాన్', 'amazon'],
  ['గూగుల్', 'google'],
];

/**
 * Whole-request page commands. Matched against the full request (after digits/sites), so a query
 * that merely contains these words is never turned into a command.
 */
const WHOLE_COMMANDS: ReadonlyArray<[RegExp, string]> = [
  // go back
  [/^(?:ಹಿಂದೆ|ಹಿಂದಕ್ಕೆ)\s+(?:ಹೋಗು|ಹೋಗಿ|ಹೋಗೋಣ)$/u, 'go back'],
  [/^(?:वापस|पीछे)\s+(?:जाओ|जाइए|चलो|जाएं)$/u, 'go back'],
  [/^(?:பின்னால்|பின்)\s+(?:போ|செல்)$/u, 'go back'],
  [/^(?:వెనక్కి|వెనుకకు)\s+(?:వెళ్ళు|వెళ్లు|వెళ్ళండి)$/u, 'go back'],
  [/^(?:hinde|hindakke)\s+(?:hogu|hogi)$/u, 'go back'],
  [/^(?:wapas|vapas|peeche|piche)\s+(?:jao|jaao|chalo)$/u, 'go back'],
  // scroll
  [/^(?:ಕೆಳಗೆ)\s+(?:ಸ್ಕ್ರೋಲ್|ಸ್ಕ್ರಾಲ್)\s+(?:ಮಾಡಿ|ಮಾಡು)$/u, 'scroll down'],
  [/^(?:ಮೇಲೆ)\s+(?:ಸ್ಕ್ರೋಲ್|ಸ್ಕ್ರಾಲ್)\s+(?:ಮಾಡಿ|ಮಾಡು)$/u, 'scroll up'],
  [/^(?:नीचे)\s+(?:स्क्रॉल|स्क्रोल)\s+(?:करो|कीजिए|करें)$/u, 'scroll down'],
  [/^(?:ऊपर)\s+(?:स्क्रॉल|स्क्रोल)\s+(?:करो|कीजिए|करें)$/u, 'scroll up'],
  [/^(?:kelage|kelake)\s+scroll\s+(?:maadi|madi|maadu|madu)$/u, 'scroll down'],
  [/^(?:mele)\s+scroll\s+(?:maadi|madi|maadu|madu)$/u, 'scroll up'],
  [/^(?:neeche|niche)\s+scroll\s+(?:karo|kijiye|karein)$/u, 'scroll down'],
  [/^(?:upar|oopar)\s+scroll\s+(?:karo|kijiye|karein)$/u, 'scroll up'],
  // add to cart
  [/^(?:ಇದನ್ನು\s+)?ಕಾರ್ಟ್(?:ಗೆ|\s+ಗೆ)\s+(?:ಸೇರಿಸಿ|ಸೇರಿಸು|ಹಾಕಿ|ಹಾಕು)$/u, 'add to cart'],
  [/^(?:इसे\s+)?कार्ट\s+में\s+(?:डालो|डालें|जोड़ो|जोड़ें|ऐड\s+करो)$/u, 'add to cart'],
  [/^(?:idannu\s+)?cart\s*(?:ge|ke)\s+(?:serisi|serisu|haaku|haaki|add\s+maadi)$/u, 'add to cart'],
  [/^(?:ise\s+)?cart\s+(?:mein|me)\s+(?:daalo|dalo|daal\s+do|jodo|add\s+karo)$/u, 'add to cart'],
  // summarize
  [/^(?:ಈ\s+)?(?:ಪುಟದ|ಪೇಜಿನ|ಪೇಜ್)\s+ಸಾರಾಂಶ(?:\s+(?:ಕೊಡಿ|ಹೇಳಿ|ನೀಡಿ))?$/u, 'summarize this page'],
  [/^ಸಾರಾಂಶ\s+(?:ಕೊಡಿ|ಹೇಳಿ|ನೀಡಿ)$/u, 'summarize this page'],
  [
    /^(?:इस\s+)?(?:पेज|पन्ने|पृष्ठ)\s+का\s+सारांश(?:\s+(?:दो|दीजिए|बताओ))?$/u,
    'summarize this page',
  ],
  [/^सारांश\s+(?:दो|दीजिए|बताओ)$/u, 'summarize this page'],
  [
    /^(?:is\s+)?page\s+ka\s+(?:summary|saaransh|saransh)(?:\s+(?:do|dijiye|batao))?$/u,
    'summarize this page',
  ],
  [/^(?:ee\s+)?page\s+(?:summary|saaramsha)(?:\s+(?:kodi|heli))?$/u, 'summarize this page'],
];

/** Phrases replaced anywhere (longest first). Canonical forms are the resolver's own vocabulary. */
const PHRASES: ReadonlyArray<[string, string]> = [
  // ── Kannada (script) ──
  ['ಪ್ಲೇ ಮಾಡಿ', 'play maadi'],
  ['ಪ್ಲೇ ಮಾಡು', 'play maadi'],
  ['ಪ್ಲೇ ಮಾಡಿರಿ', 'play maadi'],
  ['ಹಾಕಿ', 'haaku'],
  ['ಹಾಕು', 'haaku'],
  ['ಸರ್ಚ್ ಮಾಡಿ', 'search maadu'],
  ['ಸರ್ಚ್ ಮಾಡು', 'search maadu'],
  ['ಹುಡುಕಿ', 'huduku'],
  ['ಹುಡುಕು', 'huduku'],
  ['ಓಪನ್ ಮಾಡಿ', 'open maadi'],
  ['ಓಪನ್ ಮಾಡು', 'open maadi'],
  ['ತೆರೆಯಿರಿ', 'open maadi'],
  ['ತೆರೆಯಿರಿ', 'open maadi'],
  ['ತೆರೆ', 'open maadi'],
  ['ತೆಗಿ', 'open maadi'],
  ['ಅತಿ ಕಡಿಮೆ ಬೆಲೆಯ', 'cheapest'],
  ['ಕಡಿಮೆ ಬೆಲೆಯ', 'cheapest'],
  ['ಅಗ್ಗದ', 'cheapest'],
  ['ಅತಿ ದುಬಾರಿ', 'most expensive'],
  ['ದುಬಾರಿ', 'most expensive'],
  ['ನಲ್ಲಿ', 'alli'],
  ['ಅಲ್ಲಿ', 'alli'],
  ['ದಲ್ಲಿ', 'alli'],
  ['ಲ್ಲಿ', 'alli'],
  ['ಸ್ವಲ್ಪ', 'swalpa'],
  // ── Hindi (script) ──
  ['प्ले कीजिए', 'play karo'],
  ['प्ले करो', 'play karo'],
  ['प्ले करें', 'play karo'],
  ['चलाइए', 'chalao'],
  ['चलाओ', 'chalao'],
  ['बजाइए', 'bajao'],
  ['बजाओ', 'bajao'],
  ['सर्च कीजिए', 'search karo'],
  ['सर्च करो', 'search karo'],
  ['सर्च करें', 'search karo'],
  ['खोजिए', 'khojo'],
  ['खोजो', 'khojo'],
  ['ढूंढिए', 'dhoondo'],
  ['ढूंढो', 'dhoondo'],
  ['ढूँढो', 'dhoondo'],
  ['ओपन कीजिए', 'kholo'],
  ['ओपन करो', 'kholo'],
  ['खोलिए', 'kholiye'],
  ['खोलो', 'kholo'],
  ['सबसे सस्ता', 'cheapest'],
  ['सबसे सस्ती', 'cheapest'],
  ['सबसे सस्ते', 'cheapest'],
  ['सबसे महंगा', 'most expensive'],
  ['सबसे महंगी', 'most expensive'],
  ['पर', 'pe'],
  ['पे', 'pe'],
  ['में', 'mein'],
  ['कुछ', 'kuch'],
  // ── Tamil (script) ──
  ['ப்ளே பண்ணு', 'play karo'],
  ['ப்ளே செய்', 'play karo'],
  ['பாடு', 'play karo'],
  ['போடு', 'play karo'],
  ['தேடு', 'dhoondo'],
  ['திற', 'kholo'],
  ['மலிவான', 'cheapest'],
  ['ல்', 'alli'],
  ['ல', 'alli'],
  // ── Telugu (script) ──
  ['ప్లే చెయ్యి', 'play karo'],
  ['ప్లే చేయి', 'play karo'],
  ['ప్లే చేయండి', 'play karo'],
  ['వెతుకు', 'dhoondo'],
  ['వెతకండి', 'dhoondo'],
  ['తెరువు', 'kholo'],
  ['ఓపెన్ చేయి', 'kholo'],
  ['చౌకైన', 'cheapest'],
  ['లో', 'alli'],
  // ── romanized ──
  ['sabse sasta', 'cheapest'],
  ['sabse sasti', 'cheapest'],
  ['sabse saste', 'cheapest'],
  ['sabse mehenga', 'most expensive'],
  ['sabse mehnga', 'most expensive'],
  ['sabse mehengi', 'most expensive'],
  ['kadime bele', 'cheapest'],
  ['kammi bele', 'cheapest'],
  ['play pannu', 'play karo'],
  ['play cheyyi', 'play karo'],
  ['play cheyandi', 'play karo'],
  ['thedu', 'dhoondo'],
  ['vetuku', 'dhoondo'],
];

/** "₹50,000 ಒಳಗೆ / से कम / ke neeche / olage" → "under ₹50,000". */
const PRICE_POSTFIX =
  /((?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|lakh|hazaar|hazar|ಸಾವಿರ|हज़ार|हजार)?)\s*(?:रुपये|रुपए|ರೂಪಾಯಿ|rupaye|rupees?)?\s*(?:से\s+कम|के\s+नीचे|के\s+अंदर|तक|ಒಳಗೆ|ಕ್ಕಿಂತ\s+ಕಡಿಮೆ|ಗಿಂತ\s+ಕಡಿಮೆ|se\s+kam|ke\s+(?:neeche|niche|andar)|tak|olage|kinta\s+kadime|ginta\s+kadime|க்கு\s+கீழ்|లోపు)(?![\p{L}\p{M}])/giu;

function phraseRe(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`${B}${escaped}${E}`, 'giu');
}

const PHRASE_RES: ReadonlyArray<[RegExp, string]> = [...PHRASES]
  .sort((a, b) => b[0].length - a[0].length)
  .map(([from, to]) => [phraseRe(from), to]);

/** Kannada accusative ending on the word before a verb ("ಹಾಡುಗಳನ್ನು play maadi" → "ಹಾಡುಗಳು"). */
const KANNADA_PLURAL_OBJECT = /([\u0c80-\u0cff]+)ಗಳನ್ನು(?=\s)/gu;
const KANNADA_OBJECT = /([\u0c80-\u0cff]+?)ನ್ನು(?=\s)/gu;

/**
 * Rewrite a request into the resolver's canonical vocabulary. English text comes back unchanged
 * (apart from whitespace) — only Indic scripts and known romanized phrases are touched.
 */
export function canonicalize(request: string): string {
  let text = asciiDigits(request.normalize('NFC').replace(ZERO_WIDTH, ''));
  const hasIndic = /\p{Script=Devanagari}|\p{Script=Tamil}|\p{Script=Telugu}|\p{Script=Kannada}/u.test(text);
  const lower = text.toLowerCase();
  const romanized =
    /\b(?:sabse|kadime|kammi|pannu|cheyyi|cheyandi|thedu|vetuku|hinde|hindakke|wapas|vapas|peeche|piche|kelage|kelake|mele|neeche|niche|upar|oopar|serisi|daalo|dalo|olage|kinta|ginta|se kam|ke neeche|ke niche|ke andar|saaransh|saransh|saaramsha)\b/.test(
      lower,
    );
  if (!hasIndic && !romanized) return request;

  for (const [native, site] of SITE_NAMES) {
    text = text.split(native).join(` ${site} `);
  }
  text = text.replace(/\s+/g, ' ').trim();
  const whole = text
    .toLowerCase()
    .replace(/[.!?।]+$/u, '')
    .trim();
  for (const [re, command] of WHOLE_COMMANDS) {
    if (re.test(whole)) return command;
  }
  text = text.replace(PRICE_POSTFIX, (_m, amount: string) => ` under ${amount.trim()} `);
  text = text.replace(/(\d)\s*(?:ಸಾವಿರ|हज़ार|हजार|hazaar|hazar)/giu, '$1000');
  text = text.replace(KANNADA_PLURAL_OBJECT, '$1ಗಳು').replace(KANNADA_OBJECT, '$1');
  for (const [re, to] of PHRASE_RES) text = text.replace(re, ` ${to} `);
  return text.replace(/[।]+/gu, '.').replace(/\s+/g, ' ').trim();
}
