import type { Message } from '../types';

// Fixed fictional conversation for UI preview; not ASR output.
const startedAt = Date.UTC(2026, 0, 15, 14, 30);

export const sampleConversation: Message[] = [
  {
    id: 'sample-1', side: 'left',
    original: 'Let’s go through the handover checklist before Friday’s release.',
    translated: '我们先过一遍交接清单，为周五的发布做好准备。',
    isTranslating: false, createdAt: startedAt, updatedAt: startedAt,
  },
  {
    id: 'sample-2', side: 'right',
    original: '好的。测试已经完成了，使用说明还需要更新两张截图。',
    translated: 'Sure. Testing is complete. The user guide still needs two updated screenshots.',
    isTranslating: false, createdAt: startedAt + 12000, updatedAt: startedAt + 12000,
  },
  {
    id: 'sample-3', side: 'left',
    original: 'Could you confirm the owner and deadline for each open item?',
    translated: '你能确认每个待办事项的负责人和截止时间吗？',
    isTranslating: false, createdAt: startedAt + 26000, updatedAt: startedAt + 26000,
  },
  {
    id: 'sample-4', side: 'right',
    original: '我负责更新文档，明天下午完成。部署时间还需要和运维确认。',
    translated: 'I’ll update the documentation by tomorrow afternoon. We still need to confirm the deployment window with operations.',
    isTranslating: false, createdAt: startedAt + 39000, updatedAt: startedAt + 39000,
  },
  {
    id: 'sample-5', side: 'left',
    original: 'Sounds good. I’ll add that dependency to the project tracker.',
    translated: '好的。我会把这项依赖记录到项目跟踪表里。',
    isTranslating: false, createdAt: startedAt + 51000, updatedAt: startedAt + 51000,
  },
  {
    id: 'sample-6', side: 'right',
    original: '确认之后，我会把最终安排发给团队。',
    translated: 'Once it’s confirmed, I’ll share the final schedule with the team.',
    isTranslating: false, createdAt: startedAt + 62000, updatedAt: startedAt + 62000,
  },
];
