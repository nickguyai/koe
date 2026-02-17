import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ConfigManager } from '../config/config-manager';

export class LlmProcessor {
  constructor(private config: ConfigManager) {}

  private getOpenAIClient(): OpenAI {
    const apiKey = this.config.getApiKey('openai');
    if (!apiKey) {
      throw new Error('OpenAI API key is not set.');
    }
    return new OpenAI({ apiKey });
  }

  private getGeminiClient(): GoogleGenerativeAI {
    const apiKey = this.config.getApiKey('gemini');
    if (!apiKey) {
      throw new Error('Gemini API key is not set.');
    }
    return new GoogleGenerativeAI(apiKey);
  }

  async *streamOpenAI(text: string, prompt: string, model: string): AsyncGenerator<string> {
    const client = this.getOpenAIClient();
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: `${prompt}\n\n${text}` }],
      stream: true,
    });
    for await (const chunk of response) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        yield delta;
      }
    }
  }

  async *streamGemini(text: string, prompt: string, modelName: string): AsyncGenerator<string> {
    const client = this.getGeminiClient();
    const model = client.getGenerativeModel({ model: modelName });
    const stream = await model.generateContentStream(`${prompt}\n\n${text}`);
    for await (const chunk of stream.stream) {
      const chunkText = chunk.text();
      if (chunkText) {
        yield chunkText;
      }
    }
  }

  async processOpenAI(text: string, prompt: string, model: string): Promise<string> {
    const client = this.getOpenAIClient();
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: `${prompt}\n\n${text}` }],
    });
    return response.choices?.[0]?.message?.content || '';
  }

  async processGemini(text: string, prompt: string, modelName: string): Promise<string> {
    const client = this.getGeminiClient();
    const model = client.getGenerativeModel({ model: modelName });
    const response = await model.generateContent(`${prompt}\n\n${text}`);
    return response.response.text();
  }
}
