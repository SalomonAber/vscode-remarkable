import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * The reading surface. pdf.js's PDFViewer component brings the text and
 * annotation layers (so links are clickable and text is selectable), page
 * virtualisation and Ctrl+F, but no chrome of its own — the preview stays a
 * plain vertical run of pages with a status overlay for loading and failures.
 */

/** Enough to put the reader back exactly where they were, across reloads and restarts. */
interface ViewState {
	page: number;
	/** `currentScaleValue`, so a fitting mode like `page-width` survives as itself. */
	scale: string;
	top: number;
	left: number;
}

type HostMessage = { type?: string; uri?: string; message?: string };

declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };
declare global { interface Window { __remarkableWorkerUri: string; __remarkableViewState: ViewState | null } }

const status = document.getElementById('status')!;
const defaultScale = 'page-width';
const reportDelayMs = 250;

const vscode = acquireVsCodeApi();
const queued: HostMessage[] = [];
let deliver: (message: HostMessage) => void = message => { queued.push(message); };
let reportTimer: ReturnType<typeof setTimeout> | undefined;
let pagesReady = false;
/** Best known position: restored from the host, then kept current as the reader moves. */
let view: ViewState | undefined = window.__remarkableViewState ?? undefined;

// Subscribe before the viewer exists. The host posts the first PDF as soon as the
// webview loads, and the component below can only be brought in asynchronously.
window.addEventListener('message', event => deliver(event.data as HostMessage));

pdfjsLib.GlobalWorkerOptions.workerSrc = window.__remarkableWorkerUri;
// The viewer component is a webpack bundle that destructures the library off the
// global object at its top level instead of importing it, so it can only be
// loaded after this assignment — hence the dynamic import in start(). pdf.js also
// sets this itself, but relying on that side effect would make the ordering
// incidental rather than stated.
(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjsLib;

void start();

async function start(): Promise<void> {
	const { EventBus, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } = await import('pdfjs-dist/web/pdf_viewer.mjs');
	let loaded: PDFDocumentProxy | undefined;
	let loadGeneration = 0;

	const eventBus = new EventBus();
	const linkService = new PDFLinkService({
		eventBus,
		// VS Code opens http(s) anchors in the system browser, so external links
		// work as long as they carry a target the webview will not navigate itself.
		externalLinkTarget: LinkTarget.BLANK,
		externalLinkRel: 'noopener noreferrer nofollow',
	});
	const findController = new PDFFindController({ eventBus, linkService });
	const viewer = new PDFViewer({
		container: document.getElementById('viewerContainer') as HTMLDivElement,
		viewer: document.getElementById('viewer') as HTMLDivElement,
		eventBus,
		linkService,
		findController,
		// Draws link annotations without turning form fields into live inputs; the
		// preview is read-only.
		annotationMode: pdfjsLib.AnnotationMode.ENABLE,
		removePageBorders: true,
		// PDFViewer would otherwise build a GenericL10n that fetches locale bundles,
		// which a webview under this CSP cannot do.
		l10n: {
			getLanguage: () => 'en-us',
			getDirection: () => 'ltr',
			get: async (_ids: unknown, _args?: unknown, fallback?: string) => fallback ?? '',
			translate: async () => undefined,
			pause: () => undefined,
			resume: () => undefined,
		},
	});
	linkService.setViewer(viewer);

	eventBus.on('pagesinit', () => {
		viewer.currentScaleValue = view?.scale || defaultScale;
		if (view) {
			// The destination shape pdf.js uses itself to restore a remembered position.
			viewer.scrollPageIntoView({ pageNumber: view.page, destArray: [null, { name: 'XYZ' }, view.left, view.top, null] });
		}
		pagesReady = true;
		status.classList.add('hidden');
	});

	eventBus.on('updateviewarea', ({ location }: { location?: { pageNumber: number; top: number; left: number } }) => {
		// Loading and failure states reset the view area; the remembered position
		// has to survive that, so only a reader-driven move counts.
		if (!pagesReady || !location) { return; }
		view = { page: location.pageNumber, scale: viewer.currentScaleValue, top: location.top, left: location.left };
		report();
	});

	document.getElementById('app')!.addEventListener('wheel', event => {
		if (!event.ctrlKey || !pagesReady) { return; }
		event.preventDefault();
		// Hand the anchoring to pdf.js so the point under the cursor stays put.
		viewer.updateScale({ scaleFactor: Math.exp(-event.deltaY * 0.01), origin: [event.clientX, event.clientY] });
	}, { passive: false });

	const showPdf = async (uri: string): Promise<void> => {
		const generation = ++loadGeneration;
		try {
			const pdfDocument = await pdfjsLib.getDocument(uri).promise;
			if (generation !== loadGeneration) { void pdfDocument.destroy(); return; }
			const previous = loaded;
			loaded = pdfDocument;
			pagesReady = false;
			viewer.setDocument(pdfDocument);
			linkService.setDocument(pdfDocument, null);
			findController.setDocument(pdfDocument);
			void previous?.destroy();
		} catch (error) {
			if (generation === loadGeneration) { showError(error instanceof Error ? error.message : 'PDF viewer failed to load the rendered file.'); }
		}
	};

	deliver = message => {
		if (message.type === 'loading') { showStatus(text('p', 'Loading reMarkable preview…')); }
		if (message.type === 'error') { showError(message.message || 'Unknown rendering error'); }
		if (message.type === 'pdf' && typeof message.uri === 'string') { void showPdf(message.uri); }
	};
	for (const message of queued.splice(0)) { deliver(message); }
}

function showStatus(...contents: readonly HTMLElement[]): void {
	pagesReady = false;
	status.replaceChildren(...contents);
	status.classList.remove('hidden');
}

function showError(message: string): void {
	const retry = text('button', 'Retry'); retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
	const log = text('button', 'Open Output Log'); log.addEventListener('click', () => vscode.postMessage({ type: 'openOutput' }));
	const detail = text('p', message); detail.className = 'detail';
	showStatus(text('h2', 'Rendering failed'), detail, retry, log);
}

function text(tag: string, contents: string): HTMLElement { const element = document.createElement(tag); element.textContent = contents; return element; }

/** Moving reports continuously; the host only needs the resting position. */
function report(): void {
	if (reportTimer) { return; }
	reportTimer = setTimeout(() => {
		reportTimer = undefined;
		if (view) { vscode.postMessage({ type: 'viewState', ...view }); }
	}, reportDelayMs);
}
