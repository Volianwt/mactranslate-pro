export type MessageSide = 'left' | 'right';

export type Message = {
  id: string;
  side: MessageSide;
  original: string;
  corrected?: string;
  translated: string;
  isTranslating: boolean;
  createdAt: number;
  updatedAt: number;
};
