// solve.js — a fast, dependency-free drop-in for csv-reader 1.0.0 (make.fun).
//
// run(input) answers every input exactly as csv-reader 1.0.0 does: the reading of the
// case's {text, header} as {columns, rows, errors}. The semantics below mirror the
// reference reader character for character — read the text once, left to right, by the
// same broken-row policy — but the scanner is written for speed rather than legibility:
//
//   * scanning is driven by charCodeAt and indices, not by string char access;
//   * every field is taken as one bulk slice of the source rather than built up a
//     character at a time;
//   * the quoted scanner keeps a lazy `parts` array, so the common quoted field (no ""
//     and no CR inside) becomes a single slice with zero array allocations.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

const LF = 10; // '\n'
const CR = 13; // '\r'
const QUOTE = 34; // '"'
const COMMA = 44; // ','

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows (null: header).
  let recordLine = 1;
  let recordRow = null;

  while (true) {
    // A line left with no characters is no record: skip a run of lone line breaks.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && pos + 1 < len && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let lastQuoted = false; // was the record's last field a quoted one?
    let endedComma = true; // does the record still have fields to read?
    let forceUnquoted = false; // an unterminated quote re-reads the field as unquoted
    let seedQuote = false; // that re-read starts from a literal '"'

    while (endedComma || forceUnquoted) {
      endedComma = false;
      forceUnquoted = false;
      const seeded = seedQuote;
      seedQuote = false;
      if (text.charCodeAt(pos) === QUOTE) {
        // --- quoted field: runs to the next quote that is not doubled ---
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        let i = pos + 1;
        let parts = null; // lazily allocated: only if "" or CR shows up
        let segStart = i;
        let closed = false;
        while (i < len) {
          const c = text.charCodeAt(i);
          if (c === QUOTE) {
            if (i + 1 < len && text.charCodeAt(i + 1) === QUOTE) {
              if (parts === null) parts = [];
              parts.push(text.slice(segStart, i), '"');
              i += 2;
              segStart = i;
              continue;
            }
            i += 1;
            closed = true;
            break;
          }
          if (c === CR) {
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, i), '\n');
            line += 1;
            if (i + 1 < len && text.charCodeAt(i + 1) === LF) i += 2;
            else i += 1;
            segStart = i;
            continue;
          }
          if (c === LF) line += 1;
          i += 1;
        }

        if (!closed) {
          // The quote never closes: a literal quote starts the value, and the text from
          // just after the opening quote is read again as an unquoted field.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          lastQuoted = false;
          forceUnquoted = true;
          seedQuote = true;
          continue; // reread the field as unquoted from `pos`
        }

        let value;
        if (parts === null) {
          value = text.slice(segStart, i - 1);
        } else {
          parts.push(text.slice(segStart, i - 1));
          value = parts.join('');
        }
        pos = i;
        if (pos >= len) {
          fields.push(value);
          break;
        }
        let ec = text.charCodeAt(pos);
        if (ec === COMMA) {
          pos += 1;
          fields.push(value);
          endedComma = true;
          continue;
        }
        if (ec === LF) {
          pos += 1;
          line += 1;
          fields.push(value);
          break;
        }
        if (ec === CR && pos + 1 < len && text.charCodeAt(pos + 1) === LF) {
          pos += 2;
          line += 1;
          fields.push(value);
          break;
        }
        // Junk after the closing quote: appended as it stands, up to the next comma or
        // line break; quote_junk when (and only when) at least one character was added.
        const jStart = pos;
        let added = 0;
        for (;;) {
          if (pos >= len) break;
          ec = text.charCodeAt(pos);
          if (ec === COMMA || ec === LF) break;
          if (ec === CR) {
            if (pos + 1 < len && text.charCodeAt(pos + 1) === LF) break;
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            pos += 1;
            continue;
          }
          pos += 1;
          added += 1;
        }
        if (added > 0) {
          // Re-join the kept characters of the junk run (CR drops aside) as one slice
          // is not possible when stray CRs are interleaved; fall back to a joined value.
          value += junkSlice(text, jStart, pos, recordLine, recordRow, errors);
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
        fields.push(value);
        if (pos >= len) break;
        ec = text.charCodeAt(pos);
        if (ec === COMMA) {
          pos += 1;
          endedComma = true;
          continue;
        }
        if (ec === LF) {
          pos += 1;
          line += 1;
          break;
        }
        // ec === CR && next === LF
        pos += 2;
        line += 1;
        break;
      }

      // --- unquoted field (also the reread after an unterminated_quote) ---
      const start = pos;
      let parts = seeded ? ['"'] : null;
      let segStart = pos;
      for (;;) {
        if (pos >= len) {
          // end of text ends the field and the record
          if (parts === null) fields.push(text.slice(start, pos));
          else {
            parts.push(text.slice(segStart, pos));
            fields.push(parts.join(''));
          }
          break;
        }
        const c = text.charCodeAt(pos);
        if (c === COMMA) {
          if (parts === null) fields.push(text.slice(start, pos));
          else {
            parts.push(text.slice(segStart, pos));
            fields.push(parts.join(''));
          }
          pos += 1;
          endedComma = true;
          break;
        }
        if (c === LF) {
          if (parts === null) fields.push(text.slice(start, pos));
          else {
            parts.push(text.slice(segStart, pos));
            fields.push(parts.join(''));
          }
          pos += 1;
          line += 1;
          break;
        }
        if (c === CR) {
          if (pos + 1 < len && text.charCodeAt(pos + 1) === LF) {
            if (parts === null) fields.push(text.slice(start, pos));
            else {
              parts.push(text.slice(segStart, pos));
              fields.push(parts.join(''));
            }
            pos += 2;
            line += 1;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, pos));
          pos += 1;
          segStart = pos;
          continue;
        }
        pos += 1;
      }
    }

    // A line left holding only stray CRs has no characters: no record (errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// The kept characters of a junk run after a closing quote: everything but lone CRs,
// whose slice ends up excluding the dropped CR characters.
function junkSlice(text, from, to, recordLine, recordRow, errors) {
  let hasCr = false;
  for (let i = from; i < to; i += 1) {
    if (text.charCodeAt(i) === CR && !(i + 1 < to && text.charCodeAt(i + 1) === LF)) {
      hasCr = true;
      break;
    }
  }
  if (!hasCr) return text.slice(from, to);
  let out = '';
  let seg = from;
  for (let i = from; i < to; i += 1) {
    if (text.charCodeAt(i) === CR && !(i + 1 < to && text.charCodeAt(i + 1) === LF)) {
      out += text.slice(seg, i);
      seg = i + 1;
    }
  }
  return out + text.slice(seg, to);
}
