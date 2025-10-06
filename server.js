// server.js  — CommonJS & fetch only（赤線が出にくい構成）
// ※ index.html はそのままでOK

const express = require("express");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config();

// ===== 基本設定 =====
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MODEL =
  process.env.OPENAI_MODEL ||
  "ft:gpt-4o-mini-2024-07-18:personal:lear-gpt-arch:CNN73o0G";

// ===== ユーティリティ =====
function cleanLetters(s) {
  return String(s || "")
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
    .slice(0, 5);
}

function lastWord(line) {
  const m = String(line || "")
    .trim()
    .replace(/[)»”’]+$/g, "")
    .match(/([A-Za-z][A-Za-z\-']*)[.!?;,:"'»”’\)\]]*$/);
  return m ? m[1] : "";
}

function splitPoems(raw) {
  const blocks = String(raw || "").trim().split(/\n\s*\n+/);
  return blocks.map((b) =>
    b
      .split(/\n/)
      .map((ln) => ln.replace(/^\s*\d+\)\s*/, "")) // 先頭番号を除去
      .filter(Boolean)
  );
}

function checkInitials(poemLines, letters) {
  if (!poemLines || poemLines.length < 5) return false;
  const L = cleanLetters(letters);
  if (L.length !== 5) return true; // 5文字ない時は検証しない

  const ends = [
    lastWord(poemLines[0]),
    lastWord(poemLines[1]),
    lastWord(poemLines[2]),
    lastWord(poemLines[3]),
    lastWord(poemLines[4]),
  ];

  const ok =
    (ends[0][0] || "").toUpperCase() === L[0] &&
    (ends[1][0] || "").toUpperCase() === L[1] &&
    (ends[2][0] || "").toUpperCase() === L[2] &&
    (ends[3][0] || "").toUpperCase() === L[3] &&
    (ends[4][0] || "").toUpperCase() === L[4];

  return ok;
}

function everyPoemPasses(text, letters) {
  const poems = splitPoems(text);
  if (poems.length === 0) return false;
  for (let i = 0; i < poems.length; i++) {
    if (!checkInitials(poems[i], letters)) return false;
  }
  return true;
}

// ===== プロンプト =====
function buildMasterPrompt(jpWanted, lettersRaw, count) {
  const letters = cleanLetters(lettersRaw);
  const has5 = letters.length === 5;

  const alphaRule = has5
    ? [
        "END-WORD INITIALS (strict):",
        '  • Line1 end-word must start with "' + letters[0] + '".',
        '  • Line2 end-word must start with "' + letters[1] + '".',
        '  • Line3 end-word must start with "' + letters[2] + '".',
        '  • Line4 end-word must start with "' + letters[3] + '".',
        '  • Line5 end-word must start with "' + letters[4] + '".',
        "A-lines (1,2,5) must rhyme together; B-lines (3,4) must rhyme together.",
        "Use rare/compound words or archaic spellings if needed,",
        "but the initial letters of the final words must match strictly.",
      ].join("\n")
    : "If no five-letter key is given, just write normal AABBA limericks.";

  const translationRule = jpWanted
    ? "After each English line, write its Japanese translation on the next line (no extra commentary)."
    : "Write English lines only (no translation).";

  return [
    'You are "Lear-GPT (Architecture)". Generate ' + count + " five-line AABBA architectural limericks in the style of Edward Lear.",
    "Use architectural nouns like lintel, gable, pier, vault, mullion, oculus, truss, soffit, plinth, clerestory, spandrel, balustrade, wythe, quoins, corbel, voussoir, etc.",
    "Keep deadpan tone; vivid, short scenes; no moralizing.",
    alphaRule,
    translationRule,
    "Format:",
    '  • Number each poem like "1)", "2)" etc.',
    "  • Exactly 5 lines per poem.",
    "  • Separate poems with a single blank line.",
  ].join("\n");
}

function buildFixPrompt(badText, lettersRaw) {
  const L = cleanLetters(lettersRaw);
  return [
    "REPAIR TASK: The following limericks did NOT satisfy the end-word initial rule.",
    "Rewrite them so that:",
    '  Line1 ends with a word starting with "' + L[0] + '".',
    '  Line2 ends with a word starting with "' + L[1] + '".',
    '  Line3 ends with a word starting with "' + L[2] + '".',
    '  Line4 ends with a word starting with "' + L[3] + '".',
    '  Line5 ends with a word starting with "' + L[4] + '".',
    "Also keep AABBA rhymes (A=1,2,5; B=3,4).",
    "Keep the same format (numbered, 5 lines per poem, blank line between poems).",
    "Keep the same meaning; adjust minimal wording.",
    "------",
    badText,
  ].join("\n");
}

// ===== ヘルスチェック =====
app.get("/health", (_req, res) => {
  res.json({ ok: true, model: MODEL });
});

// ===== OpenAI REST 呼び出し（SDK 不使用） =====
async function callOpenAI(messages, temperature) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: temperature,
      messages: messages,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error((data && data.error && data.error.message) || "OpenAI API error");
  }
  const text =
    (data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content) ||
    "";
  return String(text).trim();
}

// ===== 生成API =====
app.post("/api/generate", async (req, res) => {
  try {
    const letters = cleanLetters((req.body && req.body.letters) || "");
    const countRaw = (req.body && req.body.count) || 1;
    const count = Math.max(1, Math.min(10, parseInt(countRaw, 10) || 1));
    const jpWanted = !!(req.body && req.body.jpWanted);

    const systemPrompt = buildMasterPrompt(jpWanted, letters, count);

    // 1回目
    let text = await callOpenAI(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Generate now." },
      ],
      0.7
    );

    // 5文字指定時は検証し、NG なら 1 回だけ修正を依頼
    if (letters.length === 5 && !everyPoemPasses(text, letters)) {
      const fixed = await callOpenAI(
        [
          { role: "system", content: "You are a strict editor that repairs constraint violations." },
          { role: "user", content: buildFixPrompt(text, letters) },
        ],
        0.5
      );
      if (everyPoemPasses(fixed, letters)) {
        text = fixed;
      }
    }

    res.json({ text });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ===== 起動 =====
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});