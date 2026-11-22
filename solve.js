// A fast drop-in for csv-reader 1.0.0, written from the RULES.txt spec.
//
// The reference reads one character at a time and grows each field a character
// at a time. This reader does the same reading, but with slices and C++-speed
// searches instead of a per-character loop:
//
//   - A record whose line holds no quote and no stray CR is split in one go
//     (String.split on the line's slice), after a probe that finds the line
//     end and checks the line for a quote and a CR. Anything else takes the
//     field-by-field path.
//   - An unquoted field is found comma-first: indexOf(',') for its end, then
//     the LF and CR checks run on the field's own slice, so no search ever
//     runs past the field. (An unbounded indexOf for CR would scan, on an LF
//     file, to the next stray CR however far away, for every field.)
//   - A quoted field is found with indexOf('"'), doubled quotes folded in,
//     and each stretch between quotes converted (CR and CRLF become LF) and
//     line-counted with bounded searches on the stretch itself.
//   - Errors, their order, and every edge of the broken-row policy follow
//     the reference exactly: BOM dropped, stray CRs dropped with an error,
//     quote junk appended with an error, an unterminated quote re-read as
//     unquoted, short/long rows padded/cut with an error.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input: {columns, rows, errors}. */
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

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read, and how many characters the unquoted scan kept for it
  // (not counting a prefix it started with: the quote_junk test reads this).
  let fieldValue = '';
  let fieldAdded = 0;

  // A stretch of text between two quotes of one quoted field, text[a..b): every
  // CRLF and lone CR in it becomes one LF, and each of those plus every LF in it
  // moves the line count on by one. Returns the stretch as the field holds it.
  function quotedSegment(a, b) {
    const s = text.slice(a, b);
    if (s.indexOf('\r') === -1) {
      let n = 0;
      let i = -1;
      while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
      line += n;
      return s;
    }
    const out = s.replace(/\r\n?/g, '\n');
    // After the replacement every line break inside the stretch is one LF.
    let n = 0;
    let i = -1;
    while ((i = out.indexOf('\n', i + 1)) !== -1) n++;
    line += n;
    return out;
  }

  // Drops the stray CRs from a stretch, one stray_cr error each, and returns
  // what is left. When crlf is true the stretch's last character is the CR of
  // the CRLF that ends the line, not a stray, and is dropped without an error.
  function stripStray(seg, crlf) {
    const last = seg.length - 1;
    let v = '';
    let p = 0;
    let stray = 0;
    for (;;) {
      const i = seg.indexOf('\r', p);
      if (i === -1) {
        v += seg.slice(p);
        break;
      }
      if (crlf && i === last) {
        v += seg.slice(p, i);
        break;
      }
      stray++;
      v += seg.slice(p, i);
      p = i + 1;
    }
    for (let k = 0; k < stray; k++) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
    return v;
  }

  // Reads an unquoted field from pos, starting with `initial` already in it,
  // up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Sets fieldValue/fieldAdded and returns how the field ended.
  function readUnquoted(initial) {
    const start = pos;
    const comma = text.indexOf(',', start);
    if (comma !== -1) {
      const seg = text.slice(start, comma);
      const nl = seg.indexOf('\n');
      if (nl === -1) {
        // Ends at the comma. Every CR in the stretch is stray: no LF in it,
        // and the character after it is the comma, so no CR is a CRLF's.
        if (seg.indexOf('\r') === -1) {
          fieldValue = initial === '' ? seg : initial + seg;
          fieldAdded = seg.length;
        } else {
          const v = stripStray(seg, false);
          fieldValue = initial === '' ? v : initial + v;
          fieldAdded = v.length;
        }
        pos = comma + 1;
        return COMMA;
      }
      // Ends at the LF inside the stretch.
      const head = seg.slice(0, nl);
      const crlf = nl > 0 && seg.charCodeAt(nl - 1) === 13;
      if (head.indexOf('\r') === -1) {
        const v = crlf ? head.slice(0, -1) : head;
        fieldValue = initial === '' ? v : initial + v;
        fieldAdded = v.length;
      } else {
        const v = stripStray(head, crlf);
        fieldValue = initial === '' ? v : initial + v;
        fieldAdded = v.length;
      }
      pos = start + nl + 1;
      line++;
      return LINE_BREAK;
    }
    const lf = text.indexOf('\n', start);
    if (lf === -1) {
      const seg = text.slice(start);
      if (seg.indexOf('\r') === -1) {
        fieldValue = initial === '' ? seg : initial + seg;
        fieldAdded = seg.length;
      } else {
        const v = stripStray(seg, false);
        fieldValue = initial === '' ? v : initial + v;
        fieldAdded = v.length;
      }
      pos = len;
      return END;
    }
    const seg = text.slice(start, lf);
    const crlf = lf > start && text.charCodeAt(lf - 1) === 13;
    if (seg.indexOf('\r') === -1) {
      const v = crlf ? seg.slice(0, -1) : seg;
      fieldValue = initial === '' ? v : initial + v;
      fieldAdded = v.length;
    } else {
      const v = stripStray(seg, crlf);
      fieldValue = initial === '' ? v : initial + v;
      fieldAdded = v.length;
    }
    pos = lf + 1;
    line++;
    return LINE_BREAK;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fieldValue and
  // returns how the field ended.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let segStart = pos + 1;
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted (the line count goes back to
        // where the quote opened, as if the quoted scan never ran).
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
        value += quotedSegment(segStart, q);
        value += '"';
        segStart = q + 2;
        p = q + 2;
        continue;
      }
      value += quotedSegment(segStart, q);
      pos = q + 1;
      break;
    }
    if (pos >= len) {
      fieldValue = value;
      return END;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos++;
      fieldValue = value;
      return COMMA;
    }
    if (c === 10) {
      pos++;
      line++;
      fieldValue = value;
      return LINE_BREAK;
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      fieldValue = value;
      return LINE_BREAK;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break (quote_junk, when the field ends with any of it).
    const ended = readUnquoted(value);
    if (fieldAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return ended;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted = false;
    // The fast line: no quote and no stray CR before the line ends, so the
    // whole record is one split. Anything else takes the field-by-field path.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? len : lf;
    const lineSeg = text.slice(pos, lineEnd);
    const hasQuote = lineSeg.indexOf('"') !== -1;
    const crAt = hasQuote ? -1 : lineSeg.indexOf('\r');
    if (!hasQuote && crAt === -1) {
      fields = lineSeg.split(',');
      if (lf === -1) pos = len;
      else {
        pos = lf + 1;
        line++;
      }
    } else if (!hasQuote && lf !== -1 && crAt === lineSeg.length - 1) {
      // The line's only CR is the one of its CRLF ending.
      fields = lineSeg.slice(0, -1).split(',');
      pos = lf + 1;
      line++;
    } else {
      fields = [];
      let ended;
      do {
        if (text.charCodeAt(pos) === 34) {
          quoted = true;
          ended = readQuoted();
        } else {
          quoted = false;
          ended = readUnquoted('');
        }
        fields.push(fieldValue);
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

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
