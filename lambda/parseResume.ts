import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { cleanResumeToPlainText } from './resumeText';

const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

const RESUMES_TABLE_NAME = process.env.RESUMES_TABLE_NAME;

interface S3EventRecord {
  eventName: string;
  s3: {
    bucket: { name: string };
    object: { key: string; size?: number };
  };
}

interface S3Event {
  Records: S3EventRecord[];
}

function mimeFromKeyAndContentType(key: string, contentType?: string): string {
  if (contentType && contentType !== 'application/octet-stream') {
    return contentType.split(';')[0].trim().toLowerCase();
  }
  const lower = key.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')) {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function bufferToResumeInput(buffer: Buffer, mime: string): string {
  if (mime.startsWith('text/')) {
    return buffer.toString('utf8');
  }
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function filenameFromKey(objectKey: string): string {
  const base = objectKey.split('/').pop() || objectKey;
  // Keys are "{uuid}-{originalFilename}"; UUID itself contains hyphens,
  // so strip the full UUID prefix rather than splitting on the first "-".
  const uuidPrefixed = base.match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i,
  );
  return uuidPrefixed?.[1] ?? base;
}

async function downloadObject(bucketName: string, objectKey: string): Promise<{
  body: Buffer;
  contentType?: string;
}> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucketName, Key: objectKey }),
  );
  const bytes = await response.Body?.transformToByteArray();
  if (!bytes) {
    throw new Error(`Empty S3 object: s3://${bucketName}/${objectKey}`);
  }
  return {
    body: Buffer.from(bytes),
    contentType: response.ContentType,
  };
}

async function saveResumeItem(params: {
  resumeId: string;
  extractedText: string;
  uploadedAt: string;
  filename: string;
  fileSize: number;
  charLength: number;
}): Promise<void> {
  if (!RESUMES_TABLE_NAME) {
    throw new Error('RESUMES_TABLE_NAME environment variable is not set');
  }

  await dynamodb.send(
    new PutItemCommand({
      TableName: RESUMES_TABLE_NAME,
      Item: {
        resumeId: { S: params.resumeId },
        extractedText: { S: params.extractedText },
        uploadedAt: { S: params.uploadedAt },
        filename: { S: params.filename },
        fileSize: { N: String(params.fileSize) },
        charLength: { N: String(params.charLength) },
      },
    }),
  );
}

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const bucketName = record.s3.bucket.name;
    const objectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const fileSize = record.s3.object.size ?? 0;
    const filename = filenameFromKey(objectKey);

    console.log('Resume uploaded', {
      bucketName,
      objectKey,
      eventName: record.eventName,
      size: record.s3.object.size,
    });

    const { body, contentType } = await downloadObject(bucketName, objectKey);
    const mime = mimeFromKeyAndContentType(objectKey, contentType);
    const resumeInput = bufferToResumeInput(body, mime);
    const plainText = await cleanResumeToPlainText(resumeInput);

    console.log('Extracted resume text (preview)', {
      bucketName,
      objectKey,
      mime,
      charLength: plainText.length,
      preview: plainText.slice(0, 200),
    });

    const uploadedAt = new Date().toISOString();
    await saveResumeItem({
      resumeId: objectKey,
      extractedText: plainText,
      uploadedAt,
      filename,
      fileSize,
      charLength: plainText.length,
    });

    console.log('Saved resume to DynamoDB', {
      resumeId: objectKey,
      tableName: RESUMES_TABLE_NAME,
      uploadedAt,
      charLength: plainText.length,
    });
  }
};
