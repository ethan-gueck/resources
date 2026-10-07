# Resources

Reference documents from [Ethan Gueck's portfolio](https://ethan-gueck.github.io/#misc), published at **https://ethan-gueck.github.io/resources/**.

| Resource | Page | Files |
| --- | --- | --- |
| Mathematics: A Comprehensive Review (Study Edition) | [math-review/](https://ethan-gueck.github.io/resources/math-review/) | [light](math-review/Math_Comprehensive_Review_Study_Edition.pdf), [dark](math-review/Math_Comprehensive_Review_Study_Edition_Dark.pdf) |

The page renders the PDF with [PDF.js](https://mozilla.github.io/pdf.js/) (vendored in `assets/pdfjs/`, Apache-2.0, so its worker is same-origin). The moon/sun button in the top-right corner switches between the light (original) and dark editions and the download button follows it; `?mode=dark` or `?mode=light` opens a given edition, otherwise the page follows the portfolio's saved light/dark choice.

## Layout

```
resources/
├── index.html                list of resources
├── math-review/
│   ├── index.html            the viewer page
│   └── *.pdf                 the published light and dark editions (built, do not edit)
├── source/                   the original PDF, as compiled
├── build/build_pdfs.py       source/ → math-review/*.pdf
└── assets/                   viewer.css, viewer.js, pdfjs/
```

## Rebuilding the PDFs

```bash
uv run build/build_pdfs.py
```

From `source/Math_Comprehensive_Review_Study_Edition.pdf` this:

- inserts a blank page wherever a section would start on an even page, so every section starts on an odd (right-hand) page: a double-sided print separates by section, and the flashcard sheets keep each back behind its front;
- adds "© Ethan Gueck 2026" to the bottom-right margin of every page;
- sets page labels to the printed page numbers (inserted pages read "Blank");
- writes the dark edition by mapping every colour onto the portfolio's dark palette (the PDF is vector-only, so text and figures stay sharp).

To publish a new version of the document, replace the file in `source/`, rebuild and push. GitHub Pages serves the `main` branch as-is.
