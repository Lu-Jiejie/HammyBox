/**
 * Discord API 封装类
 * 用于上传文件到 Discord 频道并获取文件
 */

/**
 * Discord 附件信息
 */
export interface DiscordAttachmentInfo {
  message_id: string;
  attachment_id: string;
  file_name: string;
  file_size: number;
  content_type: string;
  url: string;
  proxy_url: string;
}

/**
 * Discord 消息响应中的附件结构
 */
interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  content_type: string;
  url: string;
  proxy_url: string;
}

/**
 * Discord 消息响应
 */
interface DiscordMessageResponse {
  id?: string;
  attachments?: DiscordAttachment[];
}

export class DiscordAPI {
  botToken: string;
  baseURL: string;
  defaultHeaders: Record<string, string>;

  constructor(botToken: string) {
    this.botToken = botToken;
    this.baseURL = 'https://discord.com/api/v10';
    this.defaultHeaders = {
      Authorization: `Bot ${this.botToken}`,
      'User-Agent': 'DiscordBot (HammyBox, 1.0)',
    };
  }

  /**
   * 发送文件到 Discord 频道
   * @param file 要发送的文件
   * @param channelId 频道 ID
   * @param fileName 文件名
   * @returns API 响应结果
   */
  async sendFile(
    file: File | Blob,
    channelId: string,
    fileName = '',
  ): Promise<DiscordMessageResponse> {
    const formData = new FormData();

    // Discord 使用 files[0] 作为文件字段名
    if (fileName) {
      formData.append('files[0]', file, fileName);
    } else {
      formData.append('files[0]', file);
    }

    const response = await fetch(`${this.baseURL}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: this.defaultHeaders,
      body: formData,
    });

    console.log('Discord API response:', response.status, response.statusText);

    if (!response.ok) {
      const errorData: { message?: string } = await response.json().catch(() => ({}));
      throw new Error(`Discord API error: ${response.status} - ${errorData.message || response.statusText}`);
    }

    const responseData = (await response.json()) as DiscordMessageResponse;
    return responseData;
  }

  /**
   * 从响应中提取文件信息
   * @param responseData Discord API 响应数据
   * @returns 文件信息对象或 null
   */
  getFileInfo(responseData: DiscordMessageResponse | null): DiscordAttachmentInfo | null {
    try {
      if (!responseData || !responseData.id) {
        console.error('Invalid Discord response:', responseData);
        return null;
      }

      // Discord 消息中的附件在 attachments 数组中
      if (responseData.attachments && responseData.attachments.length > 0) {
        const attachment = responseData.attachments[0];
        return {
          message_id: responseData.id,
          attachment_id: attachment.id,
          file_name: attachment.filename,
          file_size: attachment.size,
          content_type: attachment.content_type,
          url: attachment.url,
          proxy_url: attachment.proxy_url,
        };
      }

      return null;
    } catch (error) {
      console.error('Error parsing Discord response:', (error as Error).message);
      return null;
    }
  }

  /**
   * 获取消息信息（用于获取文件 URL）
   * @param channelId 频道 ID
   * @param messageId 消息 ID
   * @param maxRetries 最大重试次数（默认 3 次）
   * @returns 消息数据或 null
   */
  async getMessage(
    channelId: string,
    messageId: string,
    maxRetries = 3,
  ): Promise<DiscordMessageResponse | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseURL}/channels/${channelId}/messages/${messageId}`, {
          method: 'GET',
          headers: this.defaultHeaders,
        });

        // 429 速率限制：等待后重试
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const waitTime = retryAfter ? parseFloat(retryAfter) * 1000 : 1000 * (attempt + 1);
          console.warn(`Discord 429 rate limit, waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);

          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        }

        if (!response.ok) {
          console.error('Discord getMessage error:', response.status, response.statusText);
          return null;
        }

        const messageData = (await response.json()) as DiscordMessageResponse;
        return messageData;
      } catch (error) {
        console.error('Error getting Discord message:', (error as Error).message);
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * 获取文件 URL
   * @param channelId 频道 ID
   * @param messageId 消息 ID
   * @returns 文件 URL 或 null
   */
  async getFileURL(channelId: string, messageId: string): Promise<string | null> {
    const message = await this.getMessage(channelId, messageId);

    if (message && message.attachments && message.attachments.length > 0) {
      return message.attachments[0].url;
    }

    return null;
  }

  /**
   * 获取文件内容
   * @param channelId 频道 ID
   * @param messageId 消息 ID
   * @returns 文件响应
   */
  async getFileContent(channelId: string, messageId: string): Promise<Response> {
    const fileURL = await this.getFileURL(channelId, messageId);

    if (!fileURL) {
      throw new Error(`File URL not found for messageId: ${messageId}`);
    }

    const response = await fetch(fileURL);
    return response;
  }

  /**
   * 删除消息（用于删除文件）
   * @param channelId 频道 ID
   * @param messageId 消息 ID
   * @returns 是否删除成功
   */
  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/channels/${channelId}/messages/${messageId}`, {
        method: 'DELETE',
        headers: this.defaultHeaders,
      });

      // Discord 删除成功返回 204 No Content
      if (response.status === 204 || response.ok) {
        return true;
      }

      console.error('Discord deleteMessage error:', response.status, response.statusText);
      return false;
    } catch (error) {
      console.error('Error deleting Discord message:', (error as Error).message);
      return false;
    }
  }
}