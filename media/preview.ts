import * as pdfjs from 'pdfjs-dist';

declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };
declare global { interface Window { __remarkableWorkerUri: string; } }

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
let page = 1;
let zoom = 1;
let scrollTop = 0;

pdfjs.GlobalWorkerOptions.workerSrc = window.__remarkableWorkerUri;

window.addEventListener('message', event => {
	const message = event.data as { type?: string; uri?: string; message?: string };
	if (message.type === 'loading') { app.replaceChildren(text('p', 'Loading reMarkable preview…')); }
	if (message.type === 'error') { showError(message.message || 'Unknown rendering error'); }
	if (message.type === 'pdf' && typeof message.uri === 'string') { void showPdf(message.uri); }
});

async function showPdf(uri: string): Promise<void> {
	try {
		const pdfDocument = await pdfjs.getDocument(uri).promise;
		const fragment = document.createDocumentFragment();
		for (let number = 1; number <= pdfDocument.numPages; number++) {
			const pdfPage = await pdfDocument.getPage(number);
			const viewport = pdfPage.getViewport({ scale: zoom });
			const canvas = document.createElement('canvas');
			canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
			canvas.setAttribute('aria-label', `Page ${number}`);
			await pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
			fragment.append(canvas);
		}
		app.replaceChildren(fragment);
		app.scrollTop = scrollTop;
	} catch (error) { showError(error instanceof Error ? error.message : 'PDF viewer failed to load the rendered file.'); }
}

function showError(message: string): void {
	const retry = text('button', 'Retry'); retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
	const log = text('button', 'Open Output Log'); log.addEventListener('click', () => vscode.postMessage({ type: 'openOutput' }));
	const detail = text('p', message); detail.className = 'detail';
	app.replaceChildren(text('h2', 'Rendering failed'), detail, retry, log);
}

function text(tag: string, contents: string): HTMLElement { const element = document.createElement(tag); element.textContent = contents; return element; }
app.addEventListener('scroll', () => { scrollTop = app.scrollTop; vscode.postMessage({ type: 'viewState', page, zoom, scrollTop }); });
