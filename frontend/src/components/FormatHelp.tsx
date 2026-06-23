export function FormatHelp() {
  return (
    <details className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
      <summary className="cursor-pointer font-medium text-slate-800 select-none">
        What kind of sheet music works?
      </summary>
      <div className="mt-3 space-y-3">
        <div>
          <p className="font-medium text-slate-800">Works</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
            <li>
              Standard SATB choral scores with all four voices written out (Soprano, Alto,
              Tenor, Bass).
            </li>
            <li>
              <span className="font-medium">Open score</span> &mdash; each voice on its own
              staff (4 staves total). Common in modern choral arrangements.
            </li>
            <li>
              <span className="font-medium">Closed score</span> &mdash; Soprano + Alto sharing
              the top staff, Tenor + Bass sharing the bottom staff (2 staves total). Common in
              hymnals.
            </li>
            <li>
              <span className="font-medium">With piano accompaniment</span> &mdash; either of
              the above plus a piano part. The piano is dropped and only the four vocal lines
              are rendered.
            </li>
          </ul>
        </div>

        <div>
          <p className="font-medium text-slate-800">Doesn&rsquo;t work yet</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
            <li>Solo voice + piano accompaniment (e.g. art songs, lieder).</li>
            <li>SAB (3 voices, no tenor) or SAT (no bass).</li>
            <li>Pieces with more than 4 vocal parts.</li>
            <li>Instrumental scores.</li>
            <li>Lead sheets (melody + chord symbols only).</li>
          </ul>
        </div>

        <div>
          <p className="font-medium text-slate-800">Tips</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-700">
            <li>
              If you have a MusicXML file (from MuseScore, Finale, Sibelius, Dorico), upload
              that &mdash; results are more accurate than from a PDF.
            </li>
            <li>
              PDF uploads use optical music recognition (OMR) and can take a couple of
              minutes. Print-quality scans work better than phone photos.
            </li>
          </ul>
        </div>
      </div>
    </details>
  );
}
