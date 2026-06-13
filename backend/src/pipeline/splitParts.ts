/**
 * MusicXML → 4 separate MIDI files (Soprano, Alto, Tenor, Bass).
 *
 * Supports two SATB encodings:
 *   1) "Open score" — 4 separate <part> elements (S, A, T, B), single voice each.
 *   2) "Closed score" — 2 <part> elements (treble = S+A, bass = T+B). Each part
 *      carries two voices, encoded either via <chord> pairs (the common case
 *      produced by music21 / MuseScore "closed score" / hymnal exports) or via
 *      explicit <voice>1</voice>/<voice>2</voice> with <backup>.
 *
 * Voice-split heuristic for closed score:
 *   - When a beat has multiple notes via <chord>: highest pitch -> upper voice
 *     (Soprano / Tenor), lowest pitch -> lower voice (Alto / Bass). Chords with
 *     3+ notes log a warning and the middle notes are dropped.
 *   - When MusicXML <voice> is present: voice 1 -> upper, voice 2 -> lower
 *     (MusicXML convention).
 *   - Monophonic beats (one pitch) -> assigned to BOTH voices (unison) which is
 *     the typical musical intent in hymnal-style scoring.
 *
 * Limitations (MVP):
 *   - Tempo from first <sound tempo="..."/> encountered, else 120.
 *   - <chord> sequences with 3+ notes drop middle pitches.
 *   - Ties / slurs / dynamics / repeats / tuplets not honoured.
 *   - .mxl (compressed MusicXML) is unwrapped transparently via loadMusicXmlText.
 */

import fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import MidiWriter from 'midi-writer-js';
import type { Voice } from '../utils/paths';
import { midiPathFor, VOICES } from '../utils/paths';
import { loadMusicXmlText } from './readMusicXml';
import { logger } from '../utils/logger';

/**
 * Thrown when the uploaded file is not a usable MusicXML score.
 * Caller (worker) records the message on the job; frontend renders it verbatim.
 */
export class MusicXmlValidationError extends Error {
  readonly code = 'MUSICXML_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'MusicXmlValidationError';
  }
}

const NOT_MUSICXML_HINT =
  'This file does not look like MusicXML. ' +
  'A valid MusicXML score has <score-partwise> or <score-timewise> as its root element. ' +
  'If you started from a PDF, online "PDF to XML" converters typically produce text-extraction XML, NOT MusicXML — ' +
  'you need OMR software (e.g. Audiveris, MuseScore PDF import, PlayScore) to get real MusicXML from a PDF.';

// midi-writer-js: 128 ticks per quarter note (its internal "T" tick base).
const TICKS_PER_QUARTER = 128;

// General MIDI: "Choir Aahs" = 53 (1-indexed). Same for all 4 voices in MVP.
const VOICE_PROGRAM: Record<Voice, number> = {
  soprano: 53,
  alto: 53,
  tenor: 53,
  bass: 53,
};

/**
 * One musical event as it appears in MusicXML, before voice-splitting.
 * Pitches are MIDI note numbers (so we can compare highest/lowest).
 * `pitches: []` means rest.
 * `tick` and `durTicks` are in midi-writer-js ticks (TICKS_PER_QUARTER per quarter).
 */
interface RawEvent {
  voice: number; // MusicXML <voice> number, defaults to 1
  tick: number; // start time within the part, in ticks
  durTicks: number;
  pitches: number[]; // empty array = rest
}

interface ParsedPart {
  partName: string;
  clef: 'treble' | 'bass' | 'other';
  events: RawEvent[];
  voiceNumbers: Set<number>; // distinct <voice> numbers seen
}

/**
 * Per-output-voice note stream we feed to MidiWriter.
 * A "note" here is a single pitch + duration (or rest if pitch === null).
 */
interface VoiceNote {
  pitch: string | null; // null = rest. Format: "C#4", "Bb3", etc.
  durTicks: number;
}

export interface SplitResult {
  tempo: number;
  partNames: string[];
  midiPaths: Record<Voice, string>;
}

function ensureArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

const STEP_TO_SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function pitchToMidi(step: string, alter: number, octave: number): number {
  // MIDI: C4 = 60. (octave + 1) * 12 + semitone.
  return (octave + 1) * 12 + STEP_TO_SEMITONE[step] + alter;
}

function midiToPitchName(midi: number): string {
  // Use sharps; choice is musically arbitrary for synthesis.
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor(midi / 12) - 1;
  const name = names[((midi % 12) + 12) % 12];
  return `${name}${octave}`;
}

function detectClef(partXml: any): 'treble' | 'bass' | 'other' {
  const measures = ensureArray(partXml.measure);
  for (const m of measures) {
    const attrs = ensureArray(m.attributes);
    for (const a of attrs) {
      const clefs = ensureArray(a.clef);
      for (const c of clefs) {
        const sign = String(c.sign ?? '').toUpperCase();
        if (sign === 'G') return 'treble';
        if (sign === 'F') return 'bass';
      }
    }
  }
  return 'other';
}

/**
 * Walk a <part>, producing time-stamped RawEvents.
 * Honours: <divisions>, <chord>, <rest>, <pitch>, <duration>, <voice>, <backup>, <forward>.
 * Ignores: ties (handled as separate notes — fine for synthesis), slurs, dynamics.
 */
function parsePartRaw(partXml: any, jobId: string, partLabel: string): ParsedPart {
  const measures = ensureArray(partXml.measure);
  let divisions = 1;
  const events: RawEvent[] = [];
  const voiceNumbers = new Set<number>();

  // Per-voice time cursors (MusicXML allows interleaved voices in a measure).
  const voiceCursor = new Map<number, number>();
  // Wall-clock cursor that <backup>/<forward> manipulate.
  let cursor = 0;

  function getVoiceCursor(v: number): number {
    if (!voiceCursor.has(v)) voiceCursor.set(v, cursor);
    return voiceCursor.get(v)!;
  }

  for (const measure of measures) {
    const measureStart = cursor;

    const attrs = ensureArray(measure.attributes);
    for (const a of attrs) {
      if (a.divisions !== undefined) {
        divisions = Number(a.divisions);
      }
    }

    // Reset per-voice cursors at the start of each measure to measureStart.
    voiceCursor.clear();

    // Iterate measure children in document order. fast-xml-parser preserves
    // children under the parent object, but to traverse in order we need to
    // either configure preserveOrder or rely on the structured form. We use
    // the structured form: notes/backup/forward are siblings — we walk
    // <note>/<backup>/<forward> arrays in their declared order using the
    // textual position of each child via a small re-parse trick.
    //
    // Simpler approach: rebuild the ordered child list from the parsed object
    // by checking known keys. fast-xml-parser >= 4 emits arrays in document
    // order *within the same tag*, but interleaving between tags is lost.
    //
    // To get true order we use a separate pass that scans with preserveOrder.
    // (Done by caller — see parseDocOrdered.) Here we only need <note>,
    // <backup>, <forward> in order, which the caller has flattened into
    // measure._ordered.
    const ordered: any[] = measure._ordered ?? [];

    let lastNonChordTick = cursor;
    let lastNonChordVoice = 1;
    let lastNonChordEventIndex = -1;
    let measureMaxTick = cursor;

    for (const child of ordered) {
      const tag = child.__tag as string;
      const node = child.__node;

      if (tag === 'note') {
        const isChord = node.chord !== undefined;
        const isRest = node.rest !== undefined;
        const duration = Number(node.duration ?? 0);
        const xmlVoice = node.voice !== undefined ? Number(node.voice) : 1;
        voiceNumbers.add(xmlVoice);

        const ticks = divisions > 0 ? Math.round((duration / divisions) * TICKS_PER_QUARTER) : 0;

        if (isChord) {
          // Attach to previous non-chord event of the same voice.
          if (lastNonChordEventIndex < 0 || isRest) {
            // Malformed (chord with no preceding note, or chord-on-rest); skip.
            continue;
          }
          if (node.pitch) {
            const step = String(node.pitch.step);
            const octave = Number(node.pitch.octave);
            const alter = node.pitch.alter !== undefined ? Number(node.pitch.alter) : 0;
            events[lastNonChordEventIndex].pitches.push(pitchToMidi(step, alter, octave));
          }
          // <chord> doesn't advance time.
          continue;
        }

        // Non-chord note (or rest): advances this voice's cursor.
        const startTick = getVoiceCursor(xmlVoice);
        const evt: RawEvent = {
          voice: xmlVoice,
          tick: startTick,
          durTicks: ticks,
          pitches: [],
        };
        if (!isRest && node.pitch) {
          const step = String(node.pitch.step);
          const octave = Number(node.pitch.octave);
          const alter = node.pitch.alter !== undefined ? Number(node.pitch.alter) : 0;
          evt.pitches.push(pitchToMidi(step, alter, octave));
        }
        events.push(evt);
        lastNonChordEventIndex = events.length - 1;
        lastNonChordTick = startTick;
        lastNonChordVoice = xmlVoice;

        const newCursor = startTick + ticks;
        voiceCursor.set(xmlVoice, newCursor);
        if (newCursor > measureMaxTick) measureMaxTick = newCursor;
        cursor = newCursor;
      } else if (tag === 'backup') {
        const duration = Number(node.duration ?? 0);
        const ticks = divisions > 0 ? Math.round((duration / divisions) * TICKS_PER_QUARTER) : 0;
        cursor = Math.max(0, cursor - ticks);
        // <backup> rewinds the wall-clock; it's normally used to start a new
        // voice from the measure beginning. We don't reset voice cursors here —
        // the next note's <voice> will look itself up via getVoiceCursor and,
        // if first sighted, anchor to current `cursor`.
        // To make that work, evict stale voice cursors that are ahead of `cursor`
        // for voices we have NOT yet anchored in this measure: do nothing — they
        // were already set above. The convention in MusicXML is that the next
        // <note> after <backup> is a *different* voice that hasn't been seen
        // this measure, so getVoiceCursor will fall through to use `cursor`.
        // If a voice IS seen again after backup in the same measure (rare),
        // we honour its existing cursor — that's correct per spec.
      } else if (tag === 'forward') {
        const duration = Number(node.duration ?? 0);
        const ticks = divisions > 0 ? Math.round((duration / divisions) * TICKS_PER_QUARTER) : 0;
        cursor += ticks;
        if (cursor > measureMaxTick) measureMaxTick = cursor;
      }
      // Other tags (attributes, print, sound, barline, direction, …) ignored.
    }

    // Advance global cursor to end of measure (max across voices).
    cursor = Math.max(cursor, measureMaxTick, measureStart);
    // Suppress unused-var lints in environments that complain.
    void lastNonChordTick;
    void lastNonChordVoice;
    void jobId;
    void partLabel;
  }

  return { partName: '', clef: 'other', events, voiceNumbers };
}

/**
 * fast-xml-parser by default loses interleaving order between *different*
 * tag names. We need <note>/<backup>/<forward> in document order within a
 * <measure>. Solution: parse once with preserveOrder, then convert each
 * <measure> into a flat ordered list of `{ __tag, __node }` and graft it
 * onto the structured DOM as `measure._ordered`.
 */
function attachOrderedMeasureChildren(structuredDoc: any, orderedDoc: any): void {
  // orderedDoc is an array of single-key objects: [{ '?xml': [...] }, { 'score-partwise': [...] }, ...]
  // We walk it, find each <part> -> <measure> and pair it with the structured one by index.
  function findOrderedChildren(orderedNode: any[], targetTag: string): any[][] {
    const results: any[][] = [];
    for (const item of orderedNode) {
      const keys = Object.keys(item).filter((k) => !k.startsWith(':@') && !k.startsWith('?'));
      const key = keys[0];
      if (!key) continue;
      const children = item[key];
      if (key === targetTag) {
        results.push(Array.isArray(children) ? children : []);
      } else if (Array.isArray(children)) {
        results.push(...findOrderedChildren(children, targetTag));
      }
    }
    return results;
  }

  // Build a flat ordered child list for one ordered <measure>.
  function flattenMeasure(orderedMeasureChildren: any[]): any[] {
    const out: any[] = [];
    for (const item of orderedMeasureChildren) {
      const keys = Object.keys(item).filter((k) => !k.startsWith(':@') && !k.startsWith('?'));
      const tag = keys[0];
      if (!tag) continue;
      // Build a structured-form node by collapsing this ordered subtree
      // back to plain object form. For our purposes we only need fields
      // we read: chord, rest, duration, voice, pitch{step,octave,alter}.
      const node = orderedToStructured(item[tag]);
      out.push({ __tag: tag, __node: node });
    }
    return out;
  }

  function orderedToStructured(arr: any): any {
    if (!Array.isArray(arr)) return arr;
    // Empty element with attributes: { '#text': '' } typically, or empty array.
    const result: any = {};
    for (const item of arr) {
      const keys = Object.keys(item).filter((k) => !k.startsWith(':@'));
      for (const k of keys) {
        const val = item[k];
        if (k === '#text') {
          // leaf text node
          result.__text = val;
        } else {
          // Empty self-closing tag like <chord/> -> [] in ordered form.
          // We mark presence with `{}` so `node.chord !== undefined` works.
          if (Array.isArray(val) && val.length === 0) {
            result[k] = {};
          } else {
            const sub = orderedToStructured(val);
            // If sub has only __text, lift to scalar.
            if (sub && typeof sub === 'object' && Object.keys(sub).length === 1 && '__text' in sub) {
              result[k] = sub.__text;
            } else {
              // If multiple of same key under one parent, keep last (we don't expect this for our fields).
              result[k] = sub;
            }
          }
        }
      }
    }
    return result;
  }

  // Now walk structuredDoc.score-partwise.part[].measure[] and pair them
  // with ordered measures by index.
  const partsStruct = ensureArray(structuredDoc['score-partwise']?.part);
  const partsOrdered = findOrderedChildren(orderedDoc, 'part');

  for (let pi = 0; pi < partsStruct.length; pi++) {
    const measuresStruct = ensureArray(partsStruct[pi].measure);
    const measuresOrdered = findOrderedChildren(partsOrdered[pi] ?? [], 'measure');
    for (let mi = 0; mi < measuresStruct.length; mi++) {
      const orderedChildren = measuresOrdered[mi] ?? [];
      measuresStruct[mi]._ordered = flattenMeasure(orderedChildren);
    }
  }
}

function findTempo(parsedDoc: any): number {
  // Scan all parts/measures for the first <sound tempo="...">.
  try {
    const parts = ensureArray(parsedDoc['score-partwise'].part);
    for (const p of parts) {
      const measures = ensureArray(p.measure);
      for (const m of measures) {
        const sounds = ensureArray(m.sound);
        for (const s of sounds) {
          if (s['@_tempo']) return Number(s['@_tempo']);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return 120;
}

/**
 * Split a parsed part into upper-voice + lower-voice note streams.
 * Used for closed-score (2-part SATB).
 *
 * Strategy:
 *   1. Group events by `voice` number.
 *   2. If multiple <voice> numbers exist: voice with smallest number = upper,
 *      next = lower. (MusicXML convention: voice 1 is the "main" upper voice.)
 *   3. Within a voice, for each event with multiple pitches (a chord):
 *      max pitch -> upper stream, min pitch -> lower stream.
 *      Chords with 3+ pitches: keep max + min, drop middle (warn).
 *   4. Monophonic events: assigned to BOTH streams (unison) — typical of
 *      hymnal-style scoring where S/A or T/B move together on some beats.
 *   5. Combine voice-1 and voice-2 streams: at each tick, if voice-1 covers
 *      it use voice-1 mapping, else use voice-2. (They normally don't overlap.)
 */
function splitClosedScorePart(
  part: ParsedPart,
  jobId: string,
  partLabel: string,
): { upper: VoiceNote[]; lower: VoiceNote[] } {
  // Sort events by (tick, voice) for stable processing.
  const sorted = [...part.events].sort((a, b) => a.tick - b.tick || a.voice - b.voice);

  // Bucket per (voice, tick) — collapse simultaneous chord pieces (already done in parser).
  // Then walk through and build two timelines.
  const upperEvents: { tick: number; durTicks: number; midi: number | null }[] = [];
  const lowerEvents: { tick: number; durTicks: number; midi: number | null }[] = [];

  // Determine "primary" voice (assigned to upper) when multiple voices exist.
  const voiceNums = [...part.voiceNumbers].sort((a, b) => a - b);
  const primaryVoice = voiceNums[0] ?? 1;
  const secondaryVoice = voiceNums[1]; // may be undefined

  let chordsTrimmed = 0;

  for (const e of sorted) {
    const isUnison = e.pitches.length <= 1;
    const isRest = e.pitches.length === 0;
    const sortedPitches = [...e.pitches].sort((a, b) => a - b);
    const lo = sortedPitches[0];
    const hi = sortedPitches[sortedPitches.length - 1];
    if (sortedPitches.length > 2) chordsTrimmed++;

    if (voiceNums.length >= 2 && e.voice === secondaryVoice) {
      // Secondary voice (typically voice 2) -> goes to LOWER stream only.
      lowerEvents.push({
        tick: e.tick,
        durTicks: e.durTicks,
        midi: isRest ? null : isUnison ? e.pitches[0] : lo,
      });
      // If somehow the secondary voice has a chord, the higher pitch goes to upper.
      if (!isRest && !isUnison) {
        upperEvents.push({ tick: e.tick, durTicks: e.durTicks, midi: hi });
      }
    } else if (voiceNums.length >= 2 && e.voice === primaryVoice) {
      // Primary voice -> UPPER. (When voice 2 is present, primary is *only* upper.)
      upperEvents.push({
        tick: e.tick,
        durTicks: e.durTicks,
        midi: isRest ? null : isUnison ? e.pitches[0] : hi,
      });
      // If primary voice itself contains a chord, the lower pitch is the lower voice.
      if (!isRest && !isUnison) {
        lowerEvents.push({ tick: e.tick, durTicks: e.durTicks, midi: lo });
      }
    } else {
      // Single-voice file (or voice 1 only). Standard chord-pair encoding.
      if (isRest) {
        upperEvents.push({ tick: e.tick, durTicks: e.durTicks, midi: null });
        lowerEvents.push({ tick: e.tick, durTicks: e.durTicks, midi: null });
      } else if (isUnison) {
        // Both voices in unison.
        upperEvents.push({ tick: e.tick, durTicks: e.durTicks, midi: e.pitches[0] });
        lowerEvents.push({ tick: e.tick, durTicks: e.durTicks, midi: e.pitches[0] });
      } else {
        upperEvents.push({ tick: e.tick, durTicks: e.durTicks, midi: hi });
        lowerEvents.push({ tick: e.tick, durTicks: e.durTicks, midi: lo });
      }
    }
  }

  if (chordsTrimmed > 0) {
    logger.warn(
      { jobId, partLabel, chordsTrimmed },
      'chord(s) had 3+ notes; kept only highest+lowest (MVP scope)',
    );
  }

  const upper = streamToVoiceNotes(upperEvents);
  const lower = streamToVoiceNotes(lowerEvents);
  return { upper, lower };
}

/**
 * Convert a sparse list of {tick, dur, midi} into a contiguous list of VoiceNotes,
 * inserting rests where there are gaps.
 */
function streamToVoiceNotes(
  evts: { tick: number; durTicks: number; midi: number | null }[],
): VoiceNote[] {
  if (evts.length === 0) return [];
  evts.sort((a, b) => a.tick - b.tick);

  // De-duplicate same (tick, midi, dur) entries that may arise when both
  // upper and lower receive a unison push.
  const dedup: typeof evts = [];
  for (const e of evts) {
    const last = dedup[dedup.length - 1];
    if (last && last.tick === e.tick && last.midi === e.midi && last.durTicks === e.durTicks) {
      continue;
    }
    dedup.push(e);
  }

  const out: VoiceNote[] = [];
  let cursor = 0;
  for (const e of dedup) {
    if (e.tick > cursor) {
      out.push({ pitch: null, durTicks: e.tick - cursor });
      cursor = e.tick;
    } else if (e.tick < cursor) {
      // Overlap (e.g. two events at the same tick from different streams collapsed).
      // Skip the overlapping one — should be rare given dedup above.
      continue;
    }
    out.push({
      pitch: e.midi === null ? null : midiToPitchName(e.midi),
      durTicks: e.durTicks,
    });
    cursor += e.durTicks;
  }
  return out;
}

/**
 * Open-score path: a part is already a single voice, so flatten its events
 * directly into VoiceNotes. Chords keep highest pitch (matches user's
 * expectation that the named "Soprano" part's top note is what they hear).
 */
function openScorePartToVoiceNotes(part: ParsedPart): VoiceNote[] {
  const sorted = [...part.events].sort((a, b) => a.tick - b.tick);
  const evts = sorted.map((e) => ({
    tick: e.tick,
    durTicks: e.durTicks,
    midi:
      e.pitches.length === 0
        ? null
        : e.pitches.reduce((m, p) => (p > m ? p : m), e.pitches[0]),
  }));
  return streamToVoiceNotes(evts);
}

function buildTrack(notes: VoiceNote[], voice: Voice, tempo: number) {
  const track = new MidiWriter.Track();
  track.addTrackName(voice);
  track.setTempo(tempo);
  track.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: VOICE_PROGRAM[voice] }));

  let pendingRestTicks = 0;
  for (const n of notes) {
    if (n.pitch === null) {
      pendingRestTicks += n.durTicks;
      continue;
    }
    track.addEvent(
      new MidiWriter.NoteEvent({
        pitch: [n.pitch],
        duration: `T${n.durTicks}`,
        wait: pendingRestTicks > 0 ? `T${pendingRestTicks}` : 0,
        velocity: 80,
      }),
    );
    pendingRestTicks = 0;
  }
  return track;
}

/**
 * Inspect <score-part> entries + <part> bodies to produce a diagnostic
 * description of an unsupported part layout. Used when the count is not
 * 2 or 4. Detects common non-SATB cases (vocal+piano, SAB, SAT) and falls
 * back to listing what was found so the user can act on it.
 *
 * Both inputs are arrays from fast-xml-parser's structured output:
 *   partList:  the <score-part> elements (with part-name, score-instrument)
 *   partsXml:  the <part> elements (whose <attributes><staves> matter)
 */
function diagnosePartLayout(partList: any[], partsXml: any[]): string {
  const partNames = partList.map((p: any) => String(p?.['part-name'] ?? '').trim());
  const lowerNames = partNames.map((n) => n.toLowerCase());
  const instrumentNames = partList.map((p: any) =>
    String(p?.['score-instrument']?.['instrument-name'] ?? '').toLowerCase(),
  );

  // Staff count from the first <attributes> block of each <part>.
  // Most parts implicitly have 1 staff; piano grand staff has 2.
  const staffCounts = partsXml.map((p: any): number => {
    const firstMeasure = ensureArray(p?.measure)[0];
    const attr = ensureArray(firstMeasure?.attributes)[0];
    const staves = attr?.staves;
    const n = staves !== undefined && staves !== null ? Number(staves) : 1;
    return Number.isFinite(n) && n > 0 ? n : 1;
  });

  const isPianoLike = (i: number): boolean =>
    /piano|keyboard|organ|grand/i.test(lowerNames[i] ?? '') ||
    /piano|keyboard|organ|grand/i.test(instrumentNames[i] ?? '') ||
    staffCounts[i] >= 2;

  const pianoIdx = staffCounts.map((_, i) => (isPianoLike(i) ? i : -1)).filter((i) => i >= 0);

  // Format a "found N parts: ..." listing for inclusion in any message.
  const found = `found ${partsXml.length} parts (${partNames
    .map((n, i) => `"${n || '(unnamed)'}"${staffCounts[i] >= 2 ? ` [${staffCounts[i]} staves]` : ''}`)
    .join(', ')})`;

  // Case 1: vocal + piano accompaniment (any part looks like piano).
  if (pianoIdx.length > 0 && partsXml.length !== 2 && partsXml.length !== 4) {
    return (
      `This score looks like a vocal + piano accompaniment, not an SATB choir score: ${found}. ` +
      `ChoirFlow currently supports only standard SATB scores ` +
      `(4 separate vocal staves, or 2 staves with women on treble + men on bass).`
    );
  }

  // Case 2: SAB — 3 parts named soprano/alto/bass (any order, no tenor).
  if (partsXml.length === 3) {
    const has = (needle: string) => lowerNames.some((n) => n.includes(needle));
    const s = has('soprano');
    const a = has('alto');
    const t = has('tenor');
    const b = has('bass');
    if (s && a && b && !t) {
      return (
        `This score looks like SAB (Soprano / Alto / Bass), not SATB: ${found}. ` +
        `ChoirFlow currently supports only 4-voice SATB scores; SAB arrangements ` +
        `(no tenor line) are not yet supported.`
      );
    }
    if (s && a && t && !b) {
      return (
        `This score looks like SAT (Soprano / Alto / Tenor), missing the bass line: ${found}. ` +
        `ChoirFlow currently supports only standard SATB scores.`
      );
    }
  }

  // Generic fallback: list what was found so the user can diagnose.
  return (
    `Expected 2 parts (closed-score: treble + bass staves) or 4 parts ` +
    `(open-score: S, A, T, B), but ${found}. ` +
    `ChoirFlow currently supports only standard SATB scores.`
  );
}

/**
 * Read a MusicXML file and write 4 MIDI files into the job's work dir.
 * Throws MusicXmlValidationError on bad/unsupported input.
 */
export async function splitToMidis(jobId: string, inputXmlPath: string): Promise<SplitResult> {
  const xml = await loadMusicXmlText(inputXmlPath);

  // Cheap pre-parse sanity check: does this look like XML at all?
  const trimmed = xml.trimStart();
  if (!trimmed.startsWith('<')) {
    throw new MusicXmlValidationError(
      `File is not XML (no opening "<" tag found). ${NOT_MUSICXML_HINT}`,
    );
  }

  // Parse twice: once structured (easy attribute access), once with
  // preserveOrder so we can recover document order of <note>/<backup>/<forward>
  // inside each <measure>.
  const structuredParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: () => false,
    parseAttributeValue: false,
  });
  const orderedParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    parseAttributeValue: false,
  });

  let doc: any;
  let docOrdered: any;
  try {
    doc = structuredParser.parse(xml);
    docOrdered = orderedParser.parse(xml);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MusicXmlValidationError(`Failed to parse XML: ${detail}. ${NOT_MUSICXML_HINT}`);
  }

  // Reject score-timewise (valid MusicXML, but we don't support it yet) and any other root.
  if (doc['score-timewise']) {
    throw new MusicXmlValidationError(
      '<score-timewise> MusicXML is not yet supported. Please export as <score-partwise> ' +
        '(the default in MuseScore, Finale, Sibelius, Dorico).',
    );
  }
  if (!doc['score-partwise']) {
    const rootKeys = Object.keys(doc).filter((k) => !k.startsWith('?'));
    const rootName = rootKeys[0] ?? '(unknown)';
    throw new MusicXmlValidationError(
      `Root element is <${rootName}>, expected <score-partwise>. ${NOT_MUSICXML_HINT}`,
    );
  }

  const partsXml = ensureArray(doc['score-partwise'].part);
  const partList = ensureArray(doc['score-partwise']['part-list']?.['score-part']);
  if (partsXml.length === 0) {
    throw new MusicXmlValidationError(
      'MusicXML contains no <part> elements. The score appears to be empty.',
    );
  }
  if (partsXml.length !== 2 && partsXml.length !== 4) {
    throw new MusicXmlValidationError(diagnosePartLayout(partList, partsXml));
  }

  // Verify at least one part has at least one note.
  const totalNotes = partsXml.reduce(
    (sum: number, p: any) =>
      sum +
      ensureArray(p.measure).reduce((s: number, m: any) => s + ensureArray(m.note).length, 0),
    0,
  );
  if (totalNotes === 0) {
    throw new MusicXmlValidationError(
      'MusicXML has parts but contains no <note> elements. Nothing to render.',
    );
  }

  // Graft document-ordered children onto each <measure>._ordered.
  attachOrderedMeasureChildren(doc, docOrdered);

  const partNames = partList.map((p: any) => String(p['part-name'] ?? '').toLowerCase());

  const tempo = findTempo(doc);

  // Parse each <part> into RawEvents.
  const parsedParts: ParsedPart[] = partsXml.map((p: any, i: number) => {
    const parsed = parsePartRaw(p, jobId, partNames[i] ?? `part${i + 1}`);
    parsed.partName = partNames[i] ?? '';
    parsed.clef = detectClef(p);
    return parsed;
  });

  const midiPaths = {} as Record<Voice, string>;
  let voiceNotesByOutput: Record<Voice, VoiceNote[]>;

  if (partsXml.length === 4) {
    // Open-score path. Trust S/A/T/B order; warn on mismatched names.
    const expected = ['soprano', 'alto', 'tenor', 'bass'];
    for (let i = 0; i < 4; i++) {
      const name = partNames[i] ?? '';
      if (name && !name.includes(expected[i])) {
        logger.warn(
          { jobId, partIndex: i, name, expected: expected[i] },
          'part name does not match expected SATB position; assuming S/A/T/B order anyway',
        );
      }
    }
    voiceNotesByOutput = {
      soprano: openScorePartToVoiceNotes(parsedParts[0]),
      alto: openScorePartToVoiceNotes(parsedParts[1]),
      tenor: openScorePartToVoiceNotes(parsedParts[2]),
      bass: openScorePartToVoiceNotes(parsedParts[3]),
    };
  } else {
    // Closed-score path. Identify treble and bass parts.
    let trebleIdx = parsedParts.findIndex((p) => p.clef === 'treble');
    let bassIdx = parsedParts.findIndex((p) => p.clef === 'bass');
    if (trebleIdx === -1 && bassIdx === -1) {
      // No clef info — assume document order: P1 = treble, P2 = bass.
      logger.warn(
        { jobId },
        '2-part score has no clefs; assuming part 1 = treble (S+A), part 2 = bass (T+B)',
      );
      trebleIdx = 0;
      bassIdx = 1;
    } else if (trebleIdx === -1) {
      trebleIdx = bassIdx === 0 ? 1 : 0;
    } else if (bassIdx === -1) {
      bassIdx = trebleIdx === 0 ? 1 : 0;
    }
    if (trebleIdx === bassIdx) {
      throw new MusicXmlValidationError(
        '2-part score has identical clefs on both staves; cannot infer which staff is S/A vs T/B. ' +
          'Please re-export as 4 separate parts (S, A, T, B).',
      );
    }

    const trebleSplit = splitClosedScorePart(
      parsedParts[trebleIdx],
      jobId,
      `part${trebleIdx + 1}/treble`,
    );
    const bassSplit = splitClosedScorePart(
      parsedParts[bassIdx],
      jobId,
      `part${bassIdx + 1}/bass`,
    );

    voiceNotesByOutput = {
      soprano: trebleSplit.upper,
      alto: trebleSplit.lower,
      tenor: bassSplit.upper,
      bass: bassSplit.lower,
    };

    logger.info(
      {
        jobId,
        treblePart: trebleIdx + 1,
        trebleName: parsedParts[trebleIdx].partName || null,
        bassPart: bassIdx + 1,
        bassName: parsedParts[bassIdx].partName || null,
      },
      'closed-score detected',
    );
  }

  for (const voice of VOICES) {
    const notes = voiceNotesByOutput[voice];
    if (notes.length === 0) {
      logger.warn({ jobId, voice }, 'voice produced 0 notes');
    }
    const track = buildTrack(notes, voice, tempo);
    const writer = new MidiWriter.Writer([track]);
    const outPath = midiPathFor(jobId, voice);
    await fs.promises.writeFile(outPath, Buffer.from(writer.buildFile()));
    midiPaths[voice] = outPath;
  }

  return { tempo, partNames, midiPaths };
}
