# CMYK Simulator

>
> This tool is an **educational simulator**. It does not use ICC profiles. 
> For production-critical work, always use professional software like Photoshop, InDesign, or your RIP software.

Free browser-based CMYK print simulator. Visualize dot gain, ink coverage, and gamut warnings before sending to print. No upload required — runs entirely client-side.

**(https://xcreativedesign.github.io/cmyk-simulator/)**

## Who is this for?
* **Design Students:** To visualize how CMYK plates combine.
* **Web Designers:** To get a "reality check" on how vibrant RGB colors might dull in print.
* **Curious Minds:** To understand the concept of Dot Gain and Ink Limits without expensive software.

## What It Does
Upload any JPG, PNG, or WEBP image and instantly see a simulated CMYK print preview. The tool shows:
* **Split-view comparison** — drag a slider to compare RGB original vs CMYK simulation.
* **Dot gain simulation** — applied as a non-linear sine curve (midtones affected most, not a flat percentage).
* **Total ink coverage (TAC)** — per-pixel calculation with paper-type ink limits.
* **Gamut warning overlay** — highlights colors outside the CMYK reproductive gamut.
* **Individual channel toggles** — isolate C, M, Y, or K plates separately.
* **Hover color picker** — see CMYK values at any point in the image.
* **Paper type presets** — Coated, Uncoated, Newsprint (each changes dot gain defaults and ink limits).

## What It Does NOT Do
*This is documented here because transparency builds trust:*
* **No ICC profiles** — The tool uses simplified mathematical RGB→CMYK conversion (K = 1 - max(R,G,B)), not Look-Up Tables derived from FOGRA39, SWOP, GRACoL, or any other standard profile.
* **Not a professional soft proof** — Results are educational approximations only. Do not use this tool as a substitute for ICC-verified soft proofing.
* **No export** — The tool cannot export actual CMYK TIFF or PDF files (this requires ICC profile integration).
* **Gamut detection is simplified** — Uses saturation + hue analysis, not 3D LUT comparison against a real ICC gamut boundary.

*(These limitations are documented in the UI as well).*

## The Color Science

### RGB → CMYK Conversion
```javascript
K = 1 - max(R, G, B)
C = (1 - R - K) / (1 - K)
M = (1 - G - K) / (1 - K)
Y = (1 - B - K) / (1 - K)
```
*Simple. Fast. Approximate. Documented as such.*

### Dot Gain Curve (Non-Linear)
```javascript
// Sine curve: peaks at midtone (0.5), falls off at extremes
const midtoneBoost = Math.sin(Math.PI * value);
const adjusted = value + gain * midtoneBoost * positionalWeight;
```
Unlike tools that add a flat percentage, this approximates the non-linear behavior of real dot gain — midtones shift most, shadows and highlights are more stable. Not the same as a real tone reproduction curve from an ICC profile, but significantly more realistic than a linear adjustment.

## File Structure
```text
cmyk-simulator/
├── index.html              ← Main tool page
├── css/
│   ├── style.css           ← All styles
│   └── animations.css      ← Motion/transitions
├── js/
│   ├── main.js             ← UI logic, DOM, events, pixel processing
│   ├── colorEngine.js      ← All color math (isolated)│   
│   └── fileHandler.js      ← File validation, resize, coordinate mapping
├── guide/                  ← Educational guide pages
├── faq/                    ← FAQ page
├── sitemap.xml
└── robots.txt
```

## Architecture Decisions
* **Web Worker for pixel processing** — All canvas pixel loops run off the main thread. The UI never freezes regardless of image size.
* **File size gate + pre-processing resize** — Images are validated (max 5MB) and resampled to max 1500×1500px before the worker receives them. The visual quality for preview purposes is unaffected.
* **Coordinate letterbox correction** — The color picker correctly calculates pixel coordinates by accounting for the offset created when `object-fit: contain` letterboxes the canvas in its container. This is a commonly broken behavior in other canvas tools.
* **`colorEngine.js` is isolated** — All color math is in one file with no DOM dependencies. This makes it auditable and testable independently.

## Run Locally

```bash
git clone https://github.com/xcreativedesign/cmyk-simulator.git
cd cmyk-simulator
npx serve .
# or: python3 -m http.server 8080
```
*No build step. No dependencies. Open `index.html` (Note: you need a local server for Web Workers to load properly due to browser CORS restrictions on the `file://` protocol).*

## Known Limitations (Documented for Credibility)

| Feature | Current State | Professional Standard |
| :--- | :--- | :--- |
| **Color conversion** | Simplified math formula | ICC Look-Up Table (FOGRA39/SWOP) |
| **Dot gain** | Non-linear sine curve | Tone Reproduction Curve from ICC profile |
| **Gamut detection**| Saturation + hue analysis | 3D LUT comparison against ICC gamut boundary |
| **Black generation** | Fixed GCR | Adjustable Light/Medium/Heavy/Max |
| **Rendering intent** | None | Perceptual / Relative Colorimetric / Absolute |

## How to Contribute
Contributions are welcome! I am particularly interested in:
* Improved gamut detection logic
* Better dot gain curve models
* Accessibility improvements
* Additional paper presets

*Please open an issue to discuss before submitting large changes.*

## References
- [ICC Profile Specification](https://www.color.org/specification/ICC.1-2022-05.pdf)
- [FOGRA39 (ISO Coated v2)](https://www.fogra.org)
- [ISO 12647-2 (Printing process standards)](https://www.color-source.net/en/Docs_Formation/2021_POINT_ABOUT_ISO_12647_STANDARDS.pdf)
- [SNAP (Newsprint standards)](https://www.snapmembers.com)

## License
MIT — Free to use, modify, and distribute.
