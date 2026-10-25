import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from './index.js';
import { formatErrorResponse } from '../utils/errors.js';
import { requireProjectSlug } from '../utils/validators.js';

const MAX_DOWNLOAD_BYTES = 1024 * 1024;

export function registerStorageTools(server: McpServer, ctx: ToolContext): void {

  // ─── List Buckets ───
  server.registerTool('nestcore_list_buckets', {
    description: 'List all storage buckets for a project. Note: uses project slug, not ID.',
    inputSchema: { projectSlug: z.string().optional() },
  }, async ({ projectSlug }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const slug = requireProjectSlug(projectSlug, ctx.session.getSession().currentProjectSlug);
      const result = await ctx.apiClient.listBuckets(slug);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Create Bucket ───
  server.registerTool('nestcore_create_bucket', {
    description: 'Create a storage bucket. public=true makes its files readable without a user token; if omitted, a new bucket is private and an existing one keeps its visibility.',
    inputSchema: {
      projectSlug: z.string().optional(),
      bucketName: z.string().min(1),
      public: z.boolean().optional(),
    },
  }, async (args) => {
    try {
      await ctx.session.ensureAuthenticated();
      const slug = requireProjectSlug(args.projectSlug, ctx.session.getSession().currentProjectSlug);
      const result = await ctx.apiClient.createBucket(slug, args.bucketName, args.public);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Delete Bucket ───
  server.registerTool('nestcore_delete_bucket', {
    description: 'Delete a storage bucket. Bucket must be empty. Requires confirmation.',
    inputSchema: {
      projectSlug: z.string().optional(),
      bucketName: z.string(),
      confirmDeletion: z.boolean(),
    },
  }, async ({ projectSlug, bucketName, confirmDeletion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const slug = requireProjectSlug(projectSlug, ctx.session.getSession().currentProjectSlug);
      if (!confirmDeletion) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Bucket deletion requires confirmDeletion=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.deleteBucket(slug, bucketName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── List Files ───
  server.registerTool('nestcore_list_files', {
    description: 'List files in a storage bucket with optional prefix filtering.',
    inputSchema: {
      projectSlug: z.string().optional(),
      bucketName: z.string(),
      prefix: z.string().optional(),
      limit: z.number().optional(),
    },
  }, async ({ projectSlug, bucketName, prefix, limit }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const slug = requireProjectSlug(projectSlug, ctx.session.getSession().currentProjectSlug);
      const result = await ctx.apiClient.listFiles(slug, bucketName, { prefix, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Upload File ───
  server.registerTool('nestcore_upload_file', {
    description: 'Upload a file to a storage bucket. File content is provided as a string (base64 for binary).',
    inputSchema: {
      projectSlug: z.string().optional(),
      bucketName: z.string(),
      filePath: z.string(),
      fileContent: z.string(),
      contentType: z.string().optional(),
      upsert: z.boolean().optional(),
    },
  }, async ({ projectSlug, bucketName, filePath, fileContent, contentType, upsert }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const slug = requireProjectSlug(projectSlug, ctx.session.getSession().currentProjectSlug);
      const result = await ctx.apiClient.uploadFile(slug, bucketName, {
        filePath, fileContent, contentType, upsert,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Download File ───
  server.registerTool('nestcore_download_file', {
    description: 'Download a file from a storage bucket. Text files (text/*, JSON, XML, CSV, JS, SVG) come back as text; anything else as base64. Files over 1 MB return only their metadata.',
    inputSchema: {
      projectSlug: z.string().optional(),
      bucketName: z.string(),
      filePath: z.string(),
    },
  }, async ({ projectSlug, bucketName, filePath }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const slug = requireProjectSlug(projectSlug, ctx.session.getSession().currentProjectSlug);
      const { contentType, bytes } = await ctx.apiClient.downloadFile(slug, bucketName, filePath);
      const meta = { filePath, contentType, size: bytes.length };
      // Keep the model's context bounded.
      if (bytes.length > MAX_DOWNLOAD_BYTES) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ...meta, note: 'File too large to return inline (limit 1 MB).' }, null, 2) }] };
      }
      const isText = /^text\/|json|xml|csv|javascript|svg/i.test(contentType);
      const payload = isText
        ? { ...meta, encoding: 'utf8', content: bytes.toString('utf8') }
        : { ...meta, encoding: 'base64', content: bytes.toString('base64') };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Delete Files ───
  server.registerTool('nestcore_delete_files', {
    description: 'Delete one or more files from a storage bucket. Requires confirmation.',
    inputSchema: {
      projectSlug: z.string().optional(),
      bucketName: z.string(),
      filePaths: z.array(z.string()),
      confirmDeletion: z.boolean(),
    },
  }, async ({ projectSlug, bucketName, filePaths, confirmDeletion }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const slug = requireProjectSlug(projectSlug, ctx.session.getSession().currentProjectSlug);
      if (!confirmDeletion) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'File deletion requires confirmDeletion=true.',
          }, null, 2) }],
        };
      }
      const result = await ctx.apiClient.deleteFiles(slug, bucketName, filePaths);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: result }, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Public URL ───
  server.registerTool('nestcore_get_public_url', {
    description: 'Get the public URL for a file in a public bucket.',
    inputSchema: {
      projectSlug: z.string().optional(),
      bucketName: z.string(),
      filePath: z.string(),
    },
  }, async ({ projectSlug, bucketName, filePath }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const slug = requireProjectSlug(projectSlug, ctx.session.getSession().currentProjectSlug);
      const result = await ctx.apiClient.getPublicUrl(slug, bucketName, filePath);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });

  // ─── Get Bucket Size ───
  server.registerTool('nestcore_get_bucket_size', {
    description: 'Get the total size of a storage bucket.',
    inputSchema: {
      projectSlug: z.string().optional(),
      bucketName: z.string(),
    },
  }, async ({ projectSlug, bucketName }) => {
    try {
      await ctx.session.ensureAuthenticated();
      const slug = requireProjectSlug(projectSlug, ctx.session.getSession().currentProjectSlug);
      const result = await ctx.apiClient.getBucketSize(slug, bucketName);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return formatErrorResponse(error);
    }
  });
}
