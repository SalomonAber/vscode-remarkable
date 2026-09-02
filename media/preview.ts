import * as pdfjs from 'pdfjs-dist';

declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };
declare global { interface Window { __remarkableWorkerUri: string; } }

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
const renderPixelRatio = 2;
let page = 1;
let zoom = 1;
let renderedZoom = 1;
let scrollTop = 0;
let scrollLeft = 0;
let currentUri: string | undefined;
let renderGeneration = 0;
let zoomTimer: ReturnType<typeof setTimeout> | undefined;

pdfjs.GlobalWorkerOptions.workerSrc = window.__remarkableWorkerUri;

window.addEventListener('message', event => {
	const message = event.data as { type?: string; uri?: string; message?: string };
	if (message.type === 'loading') { app.replaceChildren(text('p', 'Loading reMarkable preview…')); }
	if (message.type === 'error') { showError(message.message || 'Unknown rendering error'); }
	if (message.type === 'pdf' && typeof message.uri === 'string') { void showPdf(message.uri); }
});

async function showPdf(uri: string): Promise<void> {
	currentUri = uri;
	const generation = ++renderGeneration;
	const targetZoom = zoom;
	try {
		const pdfDocument = await pdfjs.getDocument(uri).promise;
		const fragment = document.createDocumentFragment();
		for (let number = 1; number <= pdfDocument.numPages; number++) {
			const pdfPage = await pdfDocument.getPage(number);
			const viewport = pdfPage.getViewport({ scale: targetZoom * renderPixelRatio });
			const canvas = document.createElement('canvas');
			canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
			canvas.style.width = `${viewport.width / renderPixelRatio}px`;
			canvas.setAttribute('aria-label', `Page ${number}`);
			await pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
			fragment.append(canvas);
		}
		if (generation !== renderGeneration) { return; }
		app.replaceChildren(fragment);
		renderedZoom = targetZoom;
		app.scrollLeft = scrollLeft;
		app.scrollTop = scrollTop;
	} catch (error) {
		if (generation === renderGeneration) { showError(error instanceof Error ? error.message : 'PDF viewer failed to load the rendered file.'); }
	}
}

function showError(message: string): void {
	const retry = text('button', 'Retry'); retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
	const log = text('button', 'Open Output Log'); log.addEventListener('click', () => vscode.postMessage({ type: 'openOutput' }));
	const detail = text('p', message); detail.className = 'detail';
	app.replaceChildren(text('h2', 'Rendering failed'), detail, retry, log);
}

function text(tag: string, contents: string): HTMLElement { const element = document.createElement(tag); element.textContent = contents; return element; }
app.addEventListener('wheel', event => {
	if (!event.ctrlKey || !currentUri) { return; }
	event.preventDefault();
	const nextZoom = Math.min(5, Math.max(0.25, zoom * Math.exp(-event.deltaY * 0.01)));
	if (Math.abs(nextZoom - zoom) < 0.001) { return; }
	const bounds = app.getBoundingClientRect();
	const x = event.clientX - bounds.left;
	const y = event.clientY - bounds.top;
	const ratio = nextZoom / zoom;
	zoom = nextZoom;
	for (const canvas of app.querySelectorAll('canvas')) { canvas.style.width = `${canvas.width * zoom / (renderedZoom * renderPixelRatio)}px`; }
	app.scrollLeft = (app.scrollLeft + x) * ratio - x;
	app.scrollTop = (app.scrollTop + y) * ratio - y;
	scrollLeft = app.scrollLeft;
	scrollTop = app.scrollTop;
	if (zoomTimer) { clearTimeout(zoomTimer); }
	zoomTimer = setTimeout(() => {
		zoomTimer = undefined;
		if (currentUri) { void showPdf(currentUri); }
	}, 80);
}, { passive: false });
app.addEventListener('scroll', () => {
	scrollTop = app.scrollTop;
	scrollLeft = app.scrollLeft;
	vscode.postMessage({ type: 'viewState', page, zoom, scrollTop });
});
