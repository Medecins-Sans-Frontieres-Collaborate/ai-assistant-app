import {
  IconCheck,
  IconCommand,
  IconFolder,
  IconHelp,
  IconRobot,
  IconSettings,
} from '@tabler/icons-react';
import { FC, MutableRefObject, useState } from 'react';

import { useTranslations } from 'next-intl';

import { CommandDefinition, CommandType } from '@/types/commands';
import { FolderInterface } from '@/types/folder';
import { Prompt } from '@/types/prompt';

interface Props {
  prompts: Prompt[];
  activePromptIndex: number;
  onSelect: () => void;
  onMouseOver: (index: number) => void;
  promptListRef: MutableRefObject<HTMLUListElement | null>;
  commands?: CommandDefinition[];
  showCommands?: boolean;
  onImmediateCommandExecution?: (command: CommandDefinition) => void;
  folders?: FolderInterface[];
}

interface CommandItemProps {
  command: CommandDefinition;
  isActive: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onImmediateExecution?: (command: CommandDefinition) => void;
}

const CommandItem: FC<CommandItemProps> = ({
  command,
  isActive,
  onClick,
  onMouseEnter,
  onImmediateExecution,
}) => {
  const [isExecuting, setIsExecuting] = useState(false);
  const getCommandIcon = (type: CommandType) => {
    switch (type) {
      case CommandType.AGENT:
        return <IconRobot size={16} className="text-blue-500" />;
      case CommandType.SETTINGS:
        return <IconSettings size={16} className="text-green-500" />;
      case CommandType.UTILITY:
        return <IconHelp size={16} className="text-purple-500" />;
      default:
        return <IconCommand size={16} className="text-gray-500" />;
    }
  };

  const t = useTranslations();

  const getCommandTypeLabel = (type: CommandType) => {
    switch (type) {
      case CommandType.AGENT:
        return t('Agent');
      case CommandType.SETTINGS:
        return t('Settings');
      case CommandType.UTILITY:
        return t('Utility');
      default:
        return t('Command');
    }
  };

  // Check if this command should execute immediately
  const shouldExecuteImmediately = [
    'enableAgents',
    'disableAgents',
    'settings',
    'privacyPolicy',
  ].includes(command.command);

  return (
    <li
      className={`group relative cursor-pointer px-3 py-2.5 text-sm transition-all duration-150 ${
        isExecuting
          ? 'bg-green-50 dark:bg-green-900/30 border-l-2 border-green-500'
          : isActive
            ? 'bg-blue-50 dark:bg-blue-900/30 border-l-2 border-blue-500'
            : 'hover:bg-gray-50 dark:hover:bg-[#2a2a2a] border-l-2 border-transparent'
      }`}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (shouldExecuteImmediately && onImmediateExecution) {
          setIsExecuting(true);
          onImmediateExecution(command);
          // Brief visual feedback
          setTimeout(() => {
            setIsExecuting(false);
          }, 300);
        } else {
          onClick();
        }
      }}
      onMouseEnter={onMouseEnter}
    >
      <div className="flex items-start gap-3">
        {isExecuting && (
          <div className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-green-500 animate-scale-in">
            <IconCheck size={12} className="text-white" />
          </div>
        )}
        <div className={`flex-shrink-0 mt-0.5 ${isExecuting ? '' : ''}`}>
          {getCommandIcon(command.type)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`font-medium transition-colors ${
                isActive
                  ? 'text-blue-700 dark:text-blue-400'
                  : 'text-blue-600 dark:text-blue-400'
              }`}
            >
              /{command.command}
            </span>
            <span className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
              {getCommandTypeLabel(command.type)}
            </span>
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 truncate">
            {command.description}
          </p>
          {isActive && (
            <div className="mt-2 space-y-1 animate-fade-in-fast">
              <div className="text-xs text-gray-500 dark:text-gray-500">
                <span className="font-mono bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                  {command.usage}
                </span>
              </div>
              {command.examples.length > 0 && (
                <div className="text-xs text-gray-500 dark:text-gray-500">
                  <span className="text-gray-400">
                    {t('example_abbreviation')}
                  </span>
                  <span className="font-mono">{command.examples[0]}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
};

interface PromptItemProps {
  prompt: Prompt;
  isActive: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}

const PromptItem: FC<PromptItemProps> = ({
  prompt,
  isActive,
  onClick,
  onMouseEnter,
}) => {
  return (
    <li
      className={`group relative cursor-pointer px-3 py-2.5 text-sm transition-all duration-150 ${
        isActive
          ? 'bg-blue-50 dark:bg-blue-900/30 border-l-2 border-blue-500'
          : 'hover:bg-gray-50 dark:hover:bg-[#2a2a2a] border-l-2 border-transparent'
      }`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={onMouseEnter}
    >
      <div className="flex items-start gap-2">
        <div className={`flex-1 min-w-0`}>
          <div
            className={`font-medium truncate transition-colors ${
              isActive
                ? 'text-blue-700 dark:text-blue-400'
                : 'text-black dark:text-white'
            }`}
          >
            {prompt.name}
          </div>
          {isActive && prompt.description && (
            <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 animate-fade-in-fast">
              {prompt.description}
            </p>
          )}
        </div>
      </div>
    </li>
  );
};

export const PromptList: FC<Props> = ({
  prompts,
  activePromptIndex,
  onSelect,
  onMouseOver,
  promptListRef,
  commands = [],
  showCommands = false,
  onImmediateCommandExecution,
  folders = [],
}) => {
  const tList = useTranslations();

  // Filter prompt folders only
  const promptFolders = folders.filter((f) => f.type === 'prompt');

  // Group prompts by folder
  const promptsByFolder: Record<string, Prompt[]> = {};
  const unfolderPrompts: Prompt[] = [];

  prompts.forEach((prompt) => {
    if (prompt.folderId) {
      if (!promptsByFolder[prompt.folderId]) {
        promptsByFolder[prompt.folderId] = [];
      }
      promptsByFolder[prompt.folderId].push(prompt);
    } else {
      unfolderPrompts.push(prompt);
    }
  });

  // Flatten prompts for indexing: commands, then folder prompts, then unfolder prompts
  const flattenedItems: Array<
    | { type: 'command'; command: CommandDefinition }
    | { type: 'folder-header'; folder: FolderInterface }
    | { type: 'prompt'; prompt: Prompt }
  > = [];

  // Add commands first
  if (showCommands) {
    commands.forEach((command) => {
      flattenedItems.push({ type: 'command', command });
    });
  }

  // Add folder headers and their prompts
  promptFolders.forEach((folder) => {
    const folderPrompts = promptsByFolder[folder.id] || [];
    if (folderPrompts.length > 0) {
      flattenedItems.push({ type: 'folder-header', folder });
      folderPrompts.forEach((prompt) => {
        flattenedItems.push({ type: 'prompt', prompt });
      });
    }
  });

  // Add unfolder prompts
  unfolderPrompts.forEach((prompt) => {
    flattenedItems.push({ type: 'prompt', prompt });
  });

  const commandsCount = showCommands ? commands.length : 0;
  const totalItems = flattenedItems.filter(
    (item) => item.type === 'command' || item.type === 'prompt',
  ).length;

  const handleItemClick = (index: number) => {
    onSelect();
  };

  const handleItemMouseEnter = (index: number) => {
    onMouseOver(index);
  };

  return (
    <ul
      ref={promptListRef}
      className="z-10 max-h-80 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-[#212121] dark:text-white animate-fade-in-fast"
    >
      {showCommands && commands.length > 0 && (
        <>
          {commands.map((command, index) => (
            <CommandItem
              key={`command-${command.command}`}
              command={command}
              isActive={index === activePromptIndex}
              onClick={() => handleItemClick(index)}
              onMouseEnter={() => handleItemMouseEnter(index)}
              onImmediateExecution={onImmediateCommandExecution}
            />
          ))}
          {prompts.length > 0 && (
            <li className="border-t border-gray-200 dark:border-gray-700 my-1" />
          )}
        </>
      )}

      {/* Render folder sections */}
      {promptFolders.map((folder) => {
        const folderPrompts = promptsByFolder[folder.id] || [];
        if (folderPrompts.length === 0) return null;

        // Find the base index for this folder's prompts
        const folderBaseIndex =
          commandsCount +
          flattenedItems
            .slice(
              0,
              flattenedItems.findIndex(
                (item) =>
                  item.type === 'folder-header' && item.folder.id === folder.id,
              ),
            )
            .filter((item) => item.type === 'prompt').length;

        return (
          <div key={folder.id}>
            <li className="sticky top-0 z-10 px-3 py-2 text-xs font-semibold text-gray-600 dark:text-gray-400 bg-gray-100/95 dark:bg-neutral-800/95 backdrop-blur-sm flex items-center gap-2 border-b border-gray-200 dark:border-neutral-700">
              <IconFolder
                size={14}
                className="text-gray-500 dark:text-gray-400"
              />
              <span className="flex-1">{folder.name}</span>
              <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-gray-200 dark:bg-neutral-700 px-2 text-[10px] font-medium text-gray-600 dark:text-gray-300">
                {folderPrompts.length}
              </span>
            </li>
            {folderPrompts.map((prompt, index) => {
              const adjustedIndex = folderBaseIndex + index;
              return (
                <PromptItem
                  key={prompt.id}
                  prompt={prompt}
                  isActive={adjustedIndex === activePromptIndex}
                  onClick={() => handleItemClick(adjustedIndex)}
                  onMouseEnter={() => handleItemMouseEnter(adjustedIndex)}
                />
              );
            })}
          </div>
        );
      })}

      {/* Render unfolder prompts */}
      {unfolderPrompts.length > 0 && (
        <>
          {promptFolders.some((f) => promptsByFolder[f.id]?.length > 0) && (
            <li className="border-t border-gray-200 dark:border-gray-700 my-1" />
          )}
          {unfolderPrompts.map((prompt, index) => {
            const adjustedIndex =
              commandsCount +
              Object.values(promptsByFolder).flat().length +
              index;
            return (
              <PromptItem
                key={prompt.id}
                prompt={prompt}
                isActive={adjustedIndex === activePromptIndex}
                onClick={() => handleItemClick(adjustedIndex)}
                onMouseEnter={() => handleItemMouseEnter(adjustedIndex)}
              />
            );
          })}
        </>
      )}

      {totalItems === 0 && (
        <li className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400 text-center">
          {tList('No commands or prompts found')}
        </li>
      )}
    </ul>
  );
};
