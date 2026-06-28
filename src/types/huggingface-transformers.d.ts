declare module '@huggingface/transformers' {
  export interface TokenizerEncoding {
    input_ids?: {
      size?: number;
      dims?: number[];
    };
  }

  export interface Tokenizer {
    (text: string, options?: Record<string, unknown>): Promise<TokenizerEncoding>;
  }

  export const AutoTokenizer: {
    from_pretrained(modelName: string): Promise<Tokenizer>;
  };

  export function pipeline(
    task: string,
    modelName: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;

  export const env: {
    allowLocalModels?: boolean;
    localModelPath?: string;
    allowRemoteModels?: boolean;
  };
}
