import { randomUUID } from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});
const BUCKET_NAME = process.env.RESUME_BUCKET_NAME;
const EXPIRES_IN_SECONDS = 5 * 60;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
};

interface ApiGatewayEvent {
  queryStringParameters?: Record<string, string | undefined> | null;
  httpMethod?: string;
}

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

/** Prevent path traversal; keep only the final path segment. */
function sanitizeFilename(raw: string): string {
  const trimmed = raw.trim();
  const base = trimmed.split(/[/\\]/).filter(Boolean).pop() ?? '';
  return base;
}

export const handler = async (event: ApiGatewayEvent) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  if (!BUCKET_NAME) {
    return jsonResponse(500, { error: 'RESUME_BUCKET_NAME is not configured' });
  }

  const filenameParam = event.queryStringParameters?.filename;
  if (!filenameParam || !filenameParam.trim()) {
    return jsonResponse(400, { error: 'Query parameter "filename" is required' });
  }

  const filename = sanitizeFilename(filenameParam);
  if (!filename) {
    return jsonResponse(400, { error: 'Invalid filename' });
  }

  const key = `${randomUUID()}-${filename}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: EXPIRES_IN_SECONDS,
  });

  return jsonResponse(200, { uploadUrl, key, filename });
};
