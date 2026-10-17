#!/usr/bin/env bash
# Build the Final report and enforce the submission constraints (plan §7.1 / §10):
#   ./report/build.sh [-t Final] [-m 10] [-s]
# -s: submission build with the student numbers of the git-ignored team-ids.tex in the title block;
#     writes <target>-submission.pdf (git-ignored), which is the file uploaded to Canvas as <target>.pdf.
#     Without -s the PDF shows names only, because report/<target>.pdf is tracked in the public repository.
# Fails when: page count > MAXPAGES, any overfull box, undefined references/citations, or a
# placeholder survives in the PDF text: a visible \pending{...} ("[PENDING: ...]", data that does
# not exist yet) or a token TODO, TBD, XXX, [citation], ??.
set -euo pipefail
TARGET="Final"; MAXPAGES=10; SUBMISSION=0
while getopts "t:m:s" o; do case "$o" in t) TARGET="$OPTARG";; m) MAXPAGES="$OPTARG";; s) SUBMISSION=1;; esac; done
cd "$(dirname "${BASH_SOURCE[0]}")"
command -v latexmk >/dev/null || { echo "latexmk not found (install TeX Live)"; exit 1; }
SOURCE="$TARGET"; EXTRA=()
if [[ "$SUBMISSION" -eq 1 ]]; then
  [[ -f team-ids.tex ]] || echo "WARNING: report/team-ids.tex not found; the submission PDF shows names only"
  TARGET="$SOURCE-submission"; EXTRA=(-jobname="$TARGET" '-usepretex=\def\SRSubmission{1}')
fi
latexmk -pdf -interaction=nonstopmode -halt-on-error -file-line-error "${EXTRA[@]}" "$SOURCE.tex" > "$TARGET.build.log" 2>&1 || { tail -40 "$TARGET.build.log"; echo "LaTeX build failed"; exit 1; }
PAGES="$(pdfinfo "$TARGET.pdf" 2>/dev/null | awk '/^Pages:/ {print $2}')"
OVERFULL="$(grep -c 'Overfull \\hbox' "$TARGET.log" || true)"
UNDEF="$(grep -cE 'Reference .* undefined|Citation .* undefined|There were undefined references' "$TARGET.log" || true)"
TEXT="$(pdftotext "$TARGET.pdf" - 2>/dev/null || true)"
PENDING="$(grep -o '\[PENDING' <<<"$TEXT" | wc -l | tr -d ' ')"
TOKENS="$(grep -cE 'TODO|TBD|XXX|\[citation\]|\?\?' <<<"$TEXT" || true)"
PLACEHOLDERS=$((PENDING + TOKENS))
printf '%s.pdf: pages=%s (max %s)  overfull=%s  undefined=%s  placeholders=%s (pending=%s, tokens=%s)\n' \
  "$TARGET" "$PAGES" "$MAXPAGES" "$OVERFULL" "$UNDEF" "$PLACEHOLDERS" "$PENDING" "$TOKENS"
STATUS=0
[[ "$PAGES" -le "$MAXPAGES" ]] || { echo "FAIL: too many pages"; STATUS=1; }
[[ "$OVERFULL" -eq 0 ]] || { echo "FAIL: overfull boxes"; grep -n 'Overfull \\hbox' "$TARGET.log" | head; STATUS=1; }
[[ "$UNDEF" -eq 0 ]] || { echo "FAIL: undefined references"; STATUS=1; }
[[ "$PLACEHOLDERS" -eq 0 ]] || { echo "FAIL: placeholders present"; STATUS=1; }
exit $STATUS
