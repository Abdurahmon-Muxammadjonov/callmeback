import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs';
import { copyFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Groq from 'groq-sdk';

export interface GroqCallAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral';
  client_mood: string;
  operator_evaluation: string;
  deal_closed: boolean;
  summary: string;
}

export interface GroqAudioProcessResult {
  transcript: string;
  analysis: GroqCallAnalysis;
  chunks: number;
}

const SEGMENT_SECONDS = 600;
const TRANSCRIBE_MODEL = 'whisper-large-v3-turbo';
const ANALYZE_MODEL = 'llama-3.3-70b-versatile';
const TMP_ROOT = path.join(os.tmpdir(), 'procell-groq');

function sortChunkFiles(files: string[]): string[] {
  return [...files].sort((left, right) => {
    const leftNum = Number(path.basename(left).match(/(\d+)/)?.[1] || 0);
    const rightNum = Number(path.basename(right).match(/(\d+)/)?.[1] || 0);
    return leftNum - rightNum;
  });
}

async function downloadAudioToTmp(audioUrl: string, targetFilePath: string): Promise<void> {
  const response = await axios.get(audioUrl, {
    responseType: 'stream',
    maxRedirects: 5,
    timeout: 120000,
    headers: {
      'User-Agent': 'Procell-Groq/1.0',
      Accept: 'audio/*,*/*',
    },
  });

  if (!response.data) {
    throw new Error('Audio stream bo\'sh qaytdi.');
  }

  await pipeline(response.data, fs.createWriteStream(targetFilePath));
}

async function splitAudioToChunks(inputFilePath: string, chunksDir: string): Promise<string[]> {
  await mkdir(chunksDir, { recursive: true });
  const ext = path.extname(inputFilePath) || '.mp3';
  const outputPattern = path.join(chunksDir, `chunk-%05d${ext}`);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputFilePath)
        .outputOptions([
          '-f segment',
          `-segment_time ${SEGMENT_SECONDS}`,
          '-c copy',
        ])
        .output(outputPattern)
        .on('end', () => resolve())
        .on('error', (error: Error) => reject(error))
        .run();
    });
  } catch (error: any) {
    const msg = String(error?.message || error || '');
    if (msg.toLowerCase().includes('cannot find ffmpeg') || msg.toLowerCase().includes('ffmpeg was not found')) {
      console.warn('ffmpeg topilmadi, chunk qilish o\'rniga bitta fayl transkripsiya qilinadi.');
      return [inputFilePath];
    }
    throw error;
  }

  const files = (await readdir(chunksDir))
    .filter((name) => name.startsWith('chunk-'))
    .map((name) => path.join(chunksDir, name));

  if (files.length === 0) {
    const inputStats = await stat(inputFilePath);
    if (inputStats.size > 0) return [inputFilePath];
    throw new Error('Chunk fayllar yaratilmadi. ffmpeg chiqishini tekshiring.');
  }

  return sortChunkFiles(files);
}

async function transcribeChunk(client: Groq, chunkPath: string): Promise<string> {
  const transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(chunkPath),
    model: TRANSCRIBE_MODEL,
    language: 'uz',
    temperature: 0,
    response_format: 'verbose_json',
  });

  const text = (transcription as any)?.text;
  if (!text || typeof text !== 'string') {
    throw new Error(`Chunk transcription bo\'sh: ${path.basename(chunkPath)}`);
  }

  return text.trim();
}

async function analyzeTranscript(client: Groq, transcript: string, extraRules = ''): Promise<GroqCallAnalysis> {
  const systemPrompt = [
    'Siz tajribali call-center QA analitikisiz.',
    'Faqat valid JSON object qaytaring. Hech qanday qo\'shimcha matn yozmang.',
    'JSON sxemasi aniq quyidagicha bo\'lsin:',
    '{',
    '  "sentiment": "positive" | "negative" | "neutral",',
    '  "client_mood": "Short context on the customer\'s emotional state in Uzbek",',
    '  "operator_evaluation": "A brief analysis of the agent\'s performance and tone in Uzbek",',
    '  "deal_closed": true | false,',
    '  "summary": "A concise 3-4 sentence summary of the entire conversation in Uzbek"',
    '}',
  ].join('\n');

  const finalSystemPrompt = extraRules ? `${systemPrompt}\n\n${extraRules}` : systemPrompt;

  const completion = await client.chat.completions.create({
    model: ANALYZE_MODEL,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: finalSystemPrompt },
      {
        role: 'user',
        content: `Quyidagi qo'ng'iroq transcriptini tahlil qil:\n\n${transcript}`,
      },
    ],
  });

  const text = completion.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error('Groq chat completion bo\'sh qaytdi.');
  }

  const parsed = JSON.parse(text) as Partial<GroqCallAnalysis>;
  const sentiment = parsed.sentiment;
  if (sentiment !== 'positive' && sentiment !== 'negative' && sentiment !== 'neutral') {
    throw new Error('Groq JSON sentiment maydoni noto\'g\'ri.');
  }

  return {
    sentiment,
    client_mood: typeof parsed.client_mood === 'string' ? parsed.client_mood : '',
    operator_evaluation: typeof parsed.operator_evaluation === 'string' ? parsed.operator_evaluation : '',
    deal_closed: Boolean(parsed.deal_closed),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}

async function removePathSafe(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

export async function processLongAudioWithGroq(audioUrl: string, extraRules = ''): Promise<GroqAudioProcessResult> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, 'source-audio.mp3');
  const chunksDir = path.join(workspaceDir, 'chunks');

  const createdFiles: string[] = [];
  console.time('groq-audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await downloadAudioToTmp(audioUrl, sourcePath);
    createdFiles.push(sourcePath);

    const chunkPaths = await splitAudioToChunks(sourcePath, chunksDir);
    createdFiles.push(...chunkPaths);

    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const transcriptParts = await Promise.all(
      chunkPaths.map((chunkPath) => transcribeChunk(client, chunkPath))
    );

    const transcript = transcriptParts
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();

    if (!transcript) {
      throw new Error('Transcription bo\'sh chiqdi.');
    }

    const analysis = await analyzeTranscript(client, transcript, extraRules);

    return {
      transcript,
      analysis,
      chunks: chunkPaths.length,
    };
  } catch (error: any) {
    throw new Error(`Groq audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(chunksDir);
    for (const filePath of createdFiles) {
      await removePathSafe(filePath);
    }
    await removePathSafe(workspaceDir);
    console.timeEnd('groq-audio-pipeline');
  }
}

export async function processLocalAudioWithGroq(localAudioPath: string, extraRules = ''): Promise<GroqAudioProcessResult> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, `source-audio${path.extname(localAudioPath) || '.mp3'}`);
  const chunksDir = path.join(workspaceDir, 'chunks');

  const createdFiles: string[] = [];
  console.time('groq-audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await copyFile(localAudioPath, sourcePath);
    createdFiles.push(sourcePath);

    const chunkPaths = await splitAudioToChunks(sourcePath, chunksDir);
    createdFiles.push(...chunkPaths);

    const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const transcriptParts = await Promise.all(
      chunkPaths.map((chunkPath) => transcribeChunk(client, chunkPath))
    );

    const transcript = transcriptParts
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();

    if (!transcript) {
      throw new Error('Transcription bo\'sh chiqdi.');
    }

    const analysis = await analyzeTranscript(client, transcript, extraRules);

    return {
      transcript,
      analysis,
      chunks: chunkPaths.length,
    };
  } catch (error: any) {
    throw new Error(`Groq audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(chunksDir);
    for (const filePath of createdFiles) {
      await removePathSafe(filePath);
    }
    await removePathSafe(workspaceDir);
    console.timeEnd('groq-audio-pipeline');
  }
}
