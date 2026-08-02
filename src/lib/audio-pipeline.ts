import axios from 'axios';
import FormData from 'form-data';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'node:fs';
import { copyFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Groq from 'groq-sdk';

export interface CallAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral';
  client_mood: string;
  operator_evaluation: string;
  deal_closed: boolean;
  summary: string;
}

export interface AudioProcessResult {
  transcript: string;
  analysis: CallAnalysis;
  chunks: number;
}

const SEGMENT_SECONDS = 600;
const ANALYZE_MODEL = 'llama-3.3-70b-versatile';
const TMP_ROOT = path.join(os.tmpdir(), 'procell-audio');
const MUXLISA_STT_URL = 'https://service.muxlisa.uz/api/v2/stt';

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
      'User-Agent': 'Procell-Audio/1.0',
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

// Muxlisa.uz — nutqni matnga aylantirish (STT).
async function transcribeChunkWithMuxlisa(chunkPath: string): Promise<string> {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error('API_KEY yo\'q.');
  }

  const form = new FormData();
  form.append('audio', fs.createReadStream(chunkPath));

  const response = await axios.request({
    method: 'POST',
    maxBodyLength: Infinity,
    url: MUXLISA_STT_URL,
    headers: { 'x-api-key': apiKey, ...form.getHeaders() },
    data: form,
    timeout: 120000,
  });

  const text = response.data?.text;
  if (typeof text !== 'string') {
    throw new Error(`Muxlisa kutilmagan javob formati qaytardi: ${path.basename(chunkPath)}`);
  }

  return text.trim();
}

// Groq (llama) — Muxlisa bergan transkriptni qo'ng'iroq tahlil skripti (mezonlari) bo'yicha baholaydi.
async function analyzeTranscript(transcript: string, extraRules = ''): Promise<CallAnalysis> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY yo\'q.');
  }

  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

  const parsed = JSON.parse(text) as Partial<CallAnalysis>;
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

async function transcribeAndAnalyze(chunkPaths: string[], extraRules: string): Promise<{ transcript: string; analysis: CallAnalysis }> {
  const transcriptParts = await Promise.all(
    chunkPaths.map((chunkPath) => transcribeChunkWithMuxlisa(chunkPath))
  );

  const transcript = transcriptParts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (!transcript) {
    throw new Error('Transcription bo\'sh chiqdi.');
  }

  const analysis = await analyzeTranscript(transcript, extraRules);

  return { transcript, analysis };
}

export async function processLongAudio(audioUrl: string, extraRules = ''): Promise<AudioProcessResult> {
  if (!process.env.API_KEY) {
    throw new Error('API_KEY yo\'q.');
  }
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, 'source-audio.mp3');
  const chunksDir = path.join(workspaceDir, 'chunks');

  const createdFiles: string[] = [];
  console.time('audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await downloadAudioToTmp(audioUrl, sourcePath);
    createdFiles.push(sourcePath);

    const chunkPaths = await splitAudioToChunks(sourcePath, chunksDir);
    createdFiles.push(...chunkPaths);

    const { transcript, analysis } = await transcribeAndAnalyze(chunkPaths, extraRules);

    return { transcript, analysis, chunks: chunkPaths.length };
  } catch (error: any) {
    throw new Error(`Audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(chunksDir);
    for (const filePath of createdFiles) {
      await removePathSafe(filePath);
    }
    await removePathSafe(workspaceDir);
    console.timeEnd('audio-pipeline');
  }
}

export async function processLocalAudio(localAudioPath: string, extraRules = ''): Promise<AudioProcessResult> {
  if (!process.env.API_KEY) {
    throw new Error('API_KEY yo\'q.');
  }
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, `source-audio${path.extname(localAudioPath) || '.mp3'}`);
  const chunksDir = path.join(workspaceDir, 'chunks');

  const createdFiles: string[] = [];
  console.time('audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await copyFile(localAudioPath, sourcePath);
    createdFiles.push(sourcePath);

    const chunkPaths = await splitAudioToChunks(sourcePath, chunksDir);
    createdFiles.push(...chunkPaths);

    const { transcript, analysis } = await transcribeAndAnalyze(chunkPaths, extraRules);

    return { transcript, analysis, chunks: chunkPaths.length };
  } catch (error: any) {
    throw new Error(`Audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(chunksDir);
    for (const filePath of createdFiles) {
      await removePathSafe(filePath);
    }
    await removePathSafe(workspaceDir);
    console.timeEnd('audio-pipeline');
  }
}
