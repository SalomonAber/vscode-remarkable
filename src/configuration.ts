import * as vscode from 'vscode';

/**
 * The settings read from more than one place, with the clamping a hand-edited
 * `settings.json` needs — `getConfiguration` hands back whatever is written
 * there, schema or no schema.
 */

const DEFAULT_RENDER_TIMEOUT_SECONDS = 300;
const MIN_RENDER_TIMEOUT_SECONDS = 10;
/** Kept well under `SCRATCH_GRACE_MS` in `cache.ts`, so a live render is never mistaken for rubble. */
const MAX_RENDER_TIMEOUT_SECONDS = 3_600;
const DEFAULT_CACHE_MAX_SIZE_MB = 500;

export function renderTimeoutMs(scope?: vscode.Uri): number {
	const seconds = vscode.workspace.getConfiguration('remarkablePreview', scope)
		.get<number>('renderTimeoutSeconds', DEFAULT_RENDER_TIMEOUT_SECONDS);
	return clamp(seconds, MIN_RENDER_TIMEOUT_SECONDS, MAX_RENDER_TIMEOUT_SECONDS, DEFAULT_RENDER_TIMEOUT_SECONDS) * 1_000;
}

export function cacheMaxSizeBytes(): number {
	const megabytes = vscode.workspace.getConfiguration('remarkablePreview')
		.get<number>('cacheMaxSizeMB', DEFAULT_CACHE_MAX_SIZE_MB);
	return clamp(megabytes, 1, Number.MAX_SAFE_INTEGER, DEFAULT_CACHE_MAX_SIZE_MB) * 1024 * 1024;
}

function clamp(value: number, low: number, high: number, fallback: number): number {
	return Math.min(high, Math.max(low, Number.isFinite(value) ? value : fallback));
}
