import {
  IconBriefcase,
  IconBulb,
  IconCalendar,
  IconChecklist,
  IconFileAnalytics,
  IconFileText,
  IconGitMerge,
  IconMail,
  IconPresentation,
  IconReportAnalytics,
  IconSourceCode,
} from '@tabler/icons-react';

export const suggestedPrompts = [
  {
    title: 'Create Diagrams',
    prompt:
      'Show me how you can create diagrams and flowcharts. What kinds of processes, workflows, or systems can you help me visualize? Give me some examples.',
    icon: IconGitMerge,
  },
  {
    title: 'Draft Professional Content',
    prompt:
      'I need help writing professional documents - emails, reports, summaries. Can you show me examples of how you can help with different types of business writing?',
    icon: IconMail,
  },
  {
    title: 'Analyze Information',
    prompt:
      'How can you help me analyze data or information? Show me different ways you might break down numbers, find patterns, or extract insights from documents or datasets.',
    icon: IconReportAnalytics,
  },
  {
    title: 'Plan & Organize',
    prompt:
      'Can you help me plan projects or organize work? Give me examples of how you might create timelines, agendas, or project plans with different structures.',
    icon: IconChecklist,
  },
  {
    title: 'Brainstorm Ideas',
    prompt:
      'I want to brainstorm solutions to a problem. Show me how you approach creative thinking and idea generation - what kinds of questions would you ask and how do you explore possibilities?',
    icon: IconBulb,
  },
  {
    title: 'Build Presentations',
    prompt:
      'How can you help me create presentations? Show me examples of different presentation structures, visual suggestions, and how you organize information for different audiences.',
    icon: IconPresentation,
  },
  {
    title: 'Work with Code',
    prompt:
      "Can you help with coding or scripts? Show me examples - whether it's writing new code, debugging issues, or explaining how something works step-by-step.",
    icon: IconSourceCode,
  },
  {
    title: 'Decision Support',
    prompt:
      "I need to make a decision but I'm not sure how to evaluate my options. Can you show me different frameworks or approaches you use to help think through choices?",
    icon: IconBriefcase,
  },
  {
    title: 'Summarize & Synthesize',
    prompt:
      'How do you help with summarizing long documents or synthesizing information from multiple sources? Show me examples of different summary formats and levels of detail.',
    icon: IconFileText,
  },
  {
    title: 'Explain Complex Topics',
    prompt:
      'Can you explain complicated concepts in simple terms? Show me how you break down complex ideas, use analogies, and adapt explanations for different knowledge levels.',
    icon: IconFileAnalytics,
  },
  {
    title: 'Create Schedules',
    prompt:
      'I need help organizing time and creating schedules. Show me different ways you can structure agendas, calendars, or time-based plans with examples.',
    icon: IconCalendar,
  },
];
