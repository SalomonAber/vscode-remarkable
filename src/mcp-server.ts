import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { McpPdfService, type McpWorkspace } from './mcp-pdf';

const CONFIG_ENVIRONMENT_VARIABLE = 'REMARKABLE_PREVIEW_MCP_CONFIG';

const configurationSchema = z.object({
	cacheDirectory: z.string().min(1),
	version: z.string().min(1),
	workspaces: z.array(z.object({
		root: z.string().min(1),
		remderPath: z.string().min(1),
		renderTimeoutMs: z.number().positive(),
	})),
});

export interface McpServerConfiguration {
	cacheDirectory: string;
	version: string;
	workspaces: McpWorkspace[];
}

export function createMcpServer(configuration: McpServerConfiguration): McpServer {
	const pdfs = new McpPdfService(configuration.cacheDirectory, configuration.workspaces);
	const server = new McpServer({ name: 'remarkable-preview', version: configuration.version });
	server.registerTool('view_remarkable_pdf', {
		title: 'View reMarkable PDF',
		description: 'Render a workspace .rmdoc through reMarkable Preview and return its cached PDF as application/pdf.',
		inputSchema: z.object({
			path: z.string().min(1).describe('Absolute, file URI, or workspace-relative path to a .rmdoc document.'),
		}),
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
	}, async ({ path }) => {
		const pdf = await pdfs.render(path);
		return {
			content: [{
				type: 'resource',
				resource: {
					uri: pdf.uri,
					mimeType: 'application/pdf',
					blob: Buffer.from(pdf.bytes).toString('base64'),
				},
			}],
		};
	});
	return server;
}

export function readConfiguration(environment: NodeJS.ProcessEnv = process.env): McpServerConfiguration {
	const serialized = environment[CONFIG_ENVIRONMENT_VARIABLE];
	if (!serialized) {
		throw new Error(`${CONFIG_ENVIRONMENT_VARIABLE} is not set.`);
	}
	return configurationSchema.parse(JSON.parse(serialized));
}

if (require.main === module) {
	try {
		const configuration = readConfiguration();
		serveStdio(() => createMcpServer(configuration), {
			onerror: error => console.error(`reMarkable Preview MCP: ${error.message}`),
		});
	} catch (error) {
		console.error(`reMarkable Preview MCP could not start: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
