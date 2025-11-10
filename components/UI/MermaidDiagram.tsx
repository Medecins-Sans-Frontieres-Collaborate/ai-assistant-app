'use client';

import { useEffect, useRef, useState } from 'react';

import mermaid from 'mermaid';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

export function MermaidDiagram({ chart, className = '' }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Check if dark mode is enabled
  const checkDarkMode = () => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
  };

  const [isDark, setIsDark] = useState(() => checkDarkMode());

  useEffect(() => {
    // Watch for theme changes
    const observer = new MutationObserver(() => {
      setIsDark(checkDarkMode());
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Initialize mermaid with theme settings based on dark mode
    const themeVariables = isDark
      ? {
          primaryColor: '#3b82f6',
          primaryTextColor: '#f3f4f6',
          primaryBorderColor: '#60a5fa',
          lineColor: '#9ca3af',
          secondaryColor: '#10b981',
          tertiaryColor: '#f59e0b',
          background: '#1f2937',
          mainBkg: '#374151',
          secondBkg: '#4b5563',
          tertiaryBkg: '#78350f',
          textColor: '#f3f4f6',
          border1: '#6b7280',
          border2: '#9ca3af',
          fontSize: '14px',
        }
      : {
          primaryColor: '#3b82f6',
          primaryTextColor: '#1f2937',
          primaryBorderColor: '#2563eb',
          lineColor: '#6b7280',
          secondaryColor: '#10b981',
          tertiaryColor: '#f59e0b',
          background: '#ffffff',
          mainBkg: '#eff6ff',
          secondBkg: '#dbeafe',
          tertiaryBkg: '#fef3c7',
          textColor: '#1f2937',
          border1: '#d1d5db',
          border2: '#9ca3af',
          fontSize: '14px',
        };

    mermaid.initialize({
      startOnLoad: false,
      theme: 'base',
      themeVariables,
    });

    // Render the diagram
    const renderDiagram = async () => {
      if (containerRef.current) {
        try {
          const uniqueId = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
          const { svg } = await mermaid.render(uniqueId, chart);
          containerRef.current.innerHTML = svg;
        } catch (error) {
          console.error('Error rendering mermaid diagram:', error);
          containerRef.current.innerHTML =
            '<p class="text-red-600">Error rendering diagram</p>';
        }
      }
    };

    renderDiagram();
  }, [chart, isDark]);

  return (
    <div ref={containerRef} className={`mermaid-container ${className}`} />
  );
}
