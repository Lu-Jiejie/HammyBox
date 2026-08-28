/**
 * Telegram API 封装类
 */

/**
 * Telegram 文件信息
 */
interface TelegramFileDetails {
  file_id: string;
  file_name: string;
  file_size: number;
}

/**
 * Telegram API 响应（含 result）
 */
interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: {
    photo?: Array<{ file_id: string; file_name?: string; file_size: number }>;
    video?: { file_id: string; file_name?: string; file_size: number };
    audio?: { file_id: string; file_name?: string; file_size: number };
    document?: { file_id: string; file_name?: string; file_size: number };
    file_path?: string;
  };
}

export class TelegramAPI {
  botToken: string;
  proxyUrl: string;
  baseURL: string;
  fileDomain: string;
  defaultHeaders: Record<string, string>;

  constructor(botToken: string, proxyUrl = '') {
    this.botToken = botToken;
    this.proxyUrl = proxyUrl;
    // 如果设置了代理域名，使用代理域名，否则使用官方 API
    const apiDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
    this.baseURL = `${apiDomain}/bot${this.botToken}`;
    this.fileDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
    this.defaultHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
    };
  }

  /**
   * 发送文件到Telegram
   * @param file 要发送的文件
   * @param chatId 聊天ID
   * @param functionName API方法名（如：sendPhoto, sendDocument等）
   * @param functionType 文件类型参数名（如：photo, document等）
   * @returns API响应结果
   */
  async sendFile(
    file: File | Blob,
    chatId: string,
    functionName: string,
    functionType: string,
    caption = '',
    fileName = '',
  ): Promise<TelegramResponse> {
    const formData = new FormData();

    formData.append('chat_id', chatId);
    if (fileName) {
      formData.append(functionType, file, fileName);
    } else {
      formData.append(functionType, file);
    }
    if (caption) {
      formData.append('caption', caption);
    }

    const response = await fetch(`${this.baseURL}/${functionName}`, {
      method: 'POST',
      headers: this.defaultHeaders,
      body: formData,
    });
    console.log('Telegram API response:', response.status, response.statusText);

    // 解析响应数据
    const responseData = (await response.json()) as TelegramResponse;

    if (!response.ok) {
      const errorMsg = responseData?.description || response.statusText;
      throw new Error(`Telegram API error: ${errorMsg}`);
    }

    return responseData;
  }

  /**
   * 获取文件信息
   * @param responseData Telegram API响应数据
   * @returns 文件信息对象或null
   */
  getFileInfo(responseData: TelegramResponse): TelegramFileDetails | null {
    const getFileDetails = (file: {
      file_id: string;
      file_name?: string;
      file_size: number;
    }): TelegramFileDetails => ({
      file_id: file.file_id,
      file_name: file.file_name || file.file_id,
      file_size: file.file_size,
    });

    try {
      if (!responseData.ok) {
        console.error('Telegram API error:', responseData.description);
        return null;
      }

      if (responseData.result?.photo) {
        const largestPhoto = responseData.result.photo.reduce((prev, current) =>
          prev.file_size > current.file_size ? prev : current,
        );
        return getFileDetails(largestPhoto);
      }

      if (responseData.result?.video) {
        return getFileDetails(responseData.result.video);
      }

      if (responseData.result?.audio) {
        return getFileDetails(responseData.result.audio);
      }

      if (responseData.result?.document) {
        return getFileDetails(responseData.result.document);
      }

      return null;
    } catch (error) {
      console.error('Error parsing Telegram response:', (error as Error).message);
      return null;
    }
  }

  /**
   * 获取文件路径
   * @param fileId 文件ID
   * @returns 文件路径或null
   */
  async getFilePath(fileId: string): Promise<string | null> {
    try {
      const url = `${this.baseURL}/getFile?file_id=${fileId}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: this.defaultHeaders,
      });

      const responseData = (await response.json()) as TelegramResponse;
      if (responseData.ok) {
        return responseData.result?.file_path ?? null;
      } else {
        console.error('Telegram getFile failed:', responseData.description || responseData);
        return null;
      }
    } catch (error) {
      console.error('Error getting file path:', (error as Error).message);
      return null;
    }
  }

  /**
   * 获取文件内容
   * @param fileId 文件ID
   * @returns 文件响应
   */
  async getFileContent(fileId: string): Promise<Response> {
    const filePath = await this.getFilePath(fileId);
    if (!filePath) {
      throw new Error(`File path not found for fileId: ${fileId}`);
    }

    const fullURL = `${this.fileDomain}/file/bot${this.botToken}/${filePath}`;
    const response = await fetch(fullURL, {
      headers: this.defaultHeaders,
    });

    return response;
  }
}