'use strict';
// Token engine: replaces direct identifiers with stable typed tokens and keeps
// the reverse map locally. Port of the verified PowerShell rules so a payload
// produced by either tool looks the same.

const KEEP_HOSTS = [
  'microsoft.com', 'office.com', 'office365.com', 'microsoftonline.com', 'windows.com',
  'windowsupdate.com', 'azure.com', 'azurewebsites.net', 'github.com', 'githubusercontent.com',
  'google.com', 'apple.com', 'adobe.com', 'mozilla.org', 'amazonaws.com', 'cloudflare.com',
  'mimecast.com', 'proofpoint.com', 'knowbe4.com', 'duo.com', 'okta.com', 'cisco.com',
  'fortinet.com', 'veeam.com', 'connectwise.com', 'ninjaone.com', 'datto.com', 'synthreo.ai',
  'powershell.org', 'nuget.org', 'python.org'
];

function luhn(number) {
  const digits = String(number).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function lineOf(text, offset) {
  let n = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// String.replace with the match offset made available to the callback.
function replaceAt(text, re, fn) {
  return text.replace(re, function (match, ...rest) {
    const offset = rest[rest.length - 2];
    return fn(match, offset, rest);
  });
}

function isKeepHost(value) {
  const v = value.toLowerCase();
  return KEEP_HOSTS.some((h) => v === h || v.endsWith('.' + h));
}

function createEngine(options) {
  const opts = options || {};
  const forward = new Map();
  const reverse = new Map();
  const counters = new Map();
  const secrets = [];
  const keepList = (opts.keepList || []).filter(Boolean).map((s) => String(s).toLowerCase());
  const keepPrivateIps = !!opts.keepPrivateIps;
  const dictionary = Array.isArray(opts.dictionary) ? opts.dictionary : [];

  function token(type, value) {
    const key = type + '|' + value.toLowerCase();
    if (forward.has(key)) return forward.get(key);
    const n = (counters.get(type) || 0) + 1;
    counters.set(type, n);
    const t = '[' + type + '_' + String(n).padStart(2, '0') + ']';
    forward.set(key, t);
    reverse.set(t, value);
    return t;
  }

  function noteSecret(rule, value, context, line) {
    secrets.push({ rule, length: value.length, context, line });
    return '[SECRET_REDACTED]';
  }

  function applySimple(text, type, re, accept) {
    return replaceAt(text, re, (m) => {
      if (accept && !accept(m)) return m;
      return token(type, m);
    });
  }

  function redact(input, sourceName) {
    let text = String(input == null ? '' : input);
    const src = sourceName || '';

    // 1. long base64 / PEM blobs
    text = text.replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{200,}={0,2}(?![A-Za-z0-9+/=])/g, '[BASE64_OMITTED]');

    text = replaceAt(text, /-----BEGIN [A-Z0-9 ]+-----[\s\S]+?-----END [A-Z0-9 ]+-----/g, (m, offset) => {
      secrets.push({ rule: 'PRIVATE-KEY-BLOCK', length: m.length, context: src, line: lineOf(text, offset) });
      return '[SECRET_REDACTED_PEM]';
    });

    // 2. vendor token formats
    const vendor = [
      { kind: 'AWS-ACCESS-KEY', re: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g },
      { kind: 'GITHUB-TOKEN', re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g },
      { kind: 'SLACK-TOKEN', re: /(?<![A-Za-z0-9-])xox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9])/g },
      { kind: 'AZURE-STORAGE-KEY', re: /AccountKey=[A-Za-z0-9+/=]{30,}/g },
      { kind: 'AZURE-SAS', re: /(?<![A-Za-z0-9])sig=[A-Za-z0-9%]{20,}/g },
      { kind: 'JWT', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g }
    ];
    for (const rule of vendor) {
      text = replaceAt(text, rule.re, (m, offset) => {
        secrets.push({ rule: rule.kind, length: m.length, context: src, line: lineOf(text, offset) });
        return '[SECRET_REDACTED]';
      });
    }

    // 3. key = value secrets (the key stays, the value is poisoned)
    text = replaceAt(
      text,
      /(?<k>\b[A-Za-z0-9_.\-]*?(?:password|passwd|pwd|passphrase|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|accountkey|sharedaccesskey|client[_-]?secret|clientsecret|connectionstring|sas[_-]?token|authtoken|access[_-]?token|refresh[_-]?token|bearer)\b[^=\r\n]{0,25}?[=:]\s*)(?<v>"[^"\r\n]{3,}"|'[^'\r\n]{3,}'|[^\s"'`,;)}\]]{4,})/gi,
      (m, offset, rest) => {
        const k = rest[0];
        const v = rest[1];
        const plain = v.replace(/^["']|["']$/g, '');
        if (/^\[[A-Z]+_\d+\]$/.test(plain) || /^\$/.test(plain) || /^\{\{/.test(plain)) return m;
        secrets.push({
          rule: 'SECRET-ASSIGNMENT', length: plain.length,
          context: src + ' :: ' + k.trim(), line: lineOf(text, offset)
        });
        const quote = v.startsWith('"') ? '"' : v.startsWith("'") ? "'" : '';
        return k + quote + '[SECRET_REDACTED]' + quote;
      }
    );

    // 4. connection strings
    text = replaceAt(
      text,
      /(?:server|data source|initial catalog|host)\s*=\s*[^;"'\r\n]{1,80};\s*[^;"'\r\n]{0,40};\s*(?:user id|uid|username)\s*=\s*[^;"'\r\n]{1,60};?\s*(?:password|pwd)?\s*=?[^;"'\r\n]{0,60}/gi,
      (m, offset) => {
        secrets.push({ rule: 'CONNECTION-STRING', length: m.length, context: src, line: lineOf(text, offset) });
        return '[CONNSTR_REDACTED]';
      }
    );

    // 5. identifiers
    text = applySimple(text, 'EMAIL', /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,24}/g);
    text = applySimple(text, 'SSN', /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g);
    text = applySimple(text, 'EIN', /(?<!\d)\d{2}-\d{7}(?!\d)/g);
    text = applySimple(text, 'CREDITCARD', /(?<![\d\-])(?:\d[ \-]?){12,18}\d(?![\d\-])/g, (m) => luhn(m));
    text = applySimple(text, 'UNC', /\\\\[A-Za-z0-9._$\-]+\\[^\s"'<>|]{0,200}/g);
    text = applySimple(text, 'USERPATH', /\b[A-Z]:\\(?:Users|Documents and Settings)\\([^\\/:*?"<>|\r\n]{1,64})/gi);
    text = applySimple(text, 'GUID', /(?<![0-9A-Fa-f\-])[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}(?![0-9A-Fa-f\-])/g);
    text = applySimple(text, 'SID', /\bS-1-\d+(?:-\d+){1,15}\b/g);
    text = applySimple(text, 'MAC', /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g);

    text = applySimple(
      text, 'IP',
      /(?<![vV])(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g,
      (m) => {
        if (keepPrivateIps && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.)/.test(m)) return false;
        if (m === '0.0.0.0' || m === '255.255.255.255') return false;
        return true;
      }
    );

    text = applySimple(
      text, 'PHONE',
      /(?<![\d\-.])(?:\+?1[ \-.]?)?(?:\(\d{3}\)[ \-.]?|\d{3}[ \-.])\d{3}[ \-.]\d{4}(?![\d\-])/g
    );

    text = applySimple(
      text, 'HOST',
      /(?<![A-Za-z0-9@.\-])(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|us|co|biz|info|local|lan|internal|corp|edu|gov|mil|uk|ca|au|nz|de|fr|nl|onmicrosoft\.com|sharepoint\.com|cloudapp\.net|azurefd\.net|amazonaws\.com)(?![A-Za-z0-9\-])/gi,
      (m) => !isKeepHost(m)
    );

    // 6. dictionary: longest first, batched so a big list never builds one huge regex
    if (dictionary.length) {
      const groups = new Map();
      for (const entry of dictionary) {
        const type = entry.type === 'ORG' ? 'ORG' : (entry.type === 'HOST' ? 'HOST' : 'NAME');
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push(entry.value);
      }

      for (const [type, values] of groups) {
        const sorted = values.slice().sort((a, b) => b.length - a.length);
        for (let i = 0; i < sorted.length; i += 400) {
          const batch = sorted.slice(i, i + 400);
          const alt = batch.map((v) => escapeRe(v).replace(/ /g, '\\s+')).join('|');
          if (!alt) continue;
          const re = new RegExp('(?<![\\p{L}\\p{N}])(?:' + alt + ')(?![\\p{L}\\p{N}])', 'giu');
          text = replaceAt(text, re, (m) => {
            if (keepList.includes(m.toLowerCase())) return m;
            return token(type, m);
          });
        }
      }
    }

    return text;
  }

  function restore(text) {
    return String(text).replace(/\[([A-Z]+)_(\d{2,4})\]/g, (m) => (
      reverse.has(m) ? reverse.get(m) : m
    ));
  }

  function toJSON() {
    const entries = [];
    for (const [tok, value] of reverse) {
      entries.push({ Type: (tok.match(/^\[([A-Z]+)_\d+\]$/) || [])[1] || 'VALUE', Token: tok, Value: value });
    }
    return { version: 1, created: new Date().toISOString(), entries };
  }

  function loadJSON(doc) {
    if (!doc || !Array.isArray(doc.entries)) return 0;
    let n = 0;
    for (const e of doc.entries) {
      if (!e || !e.Token) continue;
      reverse.set(e.Token, e.Value);
      forward.set(e.Type + '|' + String(e.Value).toLowerCase(), e.Token);
      const num = parseInt((e.Token.match(/_(\d+)\]$/) || [])[1], 10);
      if (num > (counters.get(e.Type) || 0)) counters.set(e.Type, num);
      n++;
    }
    return n;
  }

  return {
    redact,
    restore,
    toJSON,
    loadJSON,
    get tokenCount() { return reverse.size; },
    get secrets() { return secrets.slice(); }
  };
}

module.exports = { createEngine, luhn, isKeepHost, KEEP_HOSTS };
