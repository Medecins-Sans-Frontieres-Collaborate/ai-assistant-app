import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FolderInterface } from '@/types/folder';

interface ItemWithFolder {
  id: string;
  folderId?: string | null;
  [key: string]: any;
}

export interface GroupedItems<T> {
  byFolder: Record<string, T[]>;
  unfolderedItems: T[];
}

export interface UseFolderManagementReturn<T> {
  collapsedFolders: Set<string>;
  dragOverFolderId: string | null;
  isDragging: boolean;
  editingFolderId: string | null;
  editingFolderName: string;
  editInputRef: React.RefObject<HTMLInputElement | null>;

  groupedItems: GroupedItems<T>;

  toggleFolder: (folderId: string) => void;
  setDragOverFolderId: (folderId: string | null) => void;
  setIsDragging: (isDragging: boolean) => void;
  setEditingFolderId: (folderId: string | null) => void;
  setEditingFolderName: (name: string) => void;

  handleCreateFolder: (
    folderType: string,
    defaultName: string,
    onAdd: (folder: FolderInterface) => void,
  ) => void;
  handleRenameFolder: (folderId: string, currentName: string) => void;
  handleSaveFolderName: (
    onUpdate: (folderId: string, name: string) => void,
  ) => void;
  handleDeleteFolder: (
    folderId: string,
    e: React.MouseEvent,
    onDelete: (folderId: string) => void,
    confirmMessage: string,
  ) => void;

  handleDragStart: (
    e: React.DragEvent,
    itemId: string,
    dataKey?: string,
  ) => void;
  handleDrop: (
    e: React.DragEvent,
    folderId: string | null,
    onMoveToFolder: (itemId: string, folderId: string | null) => void,
    dataKey?: string,
  ) => void;
  handleDragOver: (e: React.DragEvent, folderId: string | null) => void;
  handleDragLeave: (e: React.DragEvent) => void;
}

export interface UseFolderManagementOptions<T extends ItemWithFolder> {
  items: T[];
}

export function useFolderManagement<T extends ItemWithFolder>({
  items,
}: UseFolderManagementOptions<T>): UseFolderManagementReturn<T> {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState('');

  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingFolderId && editInputRef.current) {
      setTimeout(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      }, 0);
    }
  }, [editingFolderId]);

  const groupedItems = useMemo((): GroupedItems<T> => {
    const byFolder: Record<string, T[]> = {};
    const unfolderedItems: T[] = [];

    items.forEach((item) => {
      if (item.folderId) {
        if (!byFolder[item.folderId]) {
          byFolder[item.folderId] = [];
        }
        byFolder[item.folderId].push(item);
      } else {
        unfolderedItems.push(item);
      }
    });

    return { byFolder, unfolderedItems };
  }, [items]);

  const toggleFolder = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const handleCreateFolder = useCallback(
    (
      folderType: string,
      defaultName: string,
      onAdd: (folder: FolderInterface) => void,
    ) => {
      const { v4: uuidv4 } = require('uuid');
      const newFolder: FolderInterface = {
        id: uuidv4(),
        name: defaultName,
        type: folderType as 'chat' | 'prompt' | 'tone',
      };
      onAdd(newFolder);
      setEditingFolderId(newFolder.id);
      setEditingFolderName(newFolder.name);
    },
    [],
  );

  const handleRenameFolder = useCallback(
    (folderId: string, currentName: string) => {
      setEditingFolderId(folderId);
      setEditingFolderName(currentName);
    },
    [],
  );

  const handleSaveFolderName = useCallback(
    (onUpdate: (folderId: string, name: string) => void) => {
      if (editingFolderId && editingFolderName.trim()) {
        onUpdate(editingFolderId, editingFolderName.trim());
      }
      setEditingFolderId(null);
      setEditingFolderName('');
    },
    [editingFolderId, editingFolderName],
  );

  const handleDeleteFolder = useCallback(
    (
      folderId: string,
      e: React.MouseEvent,
      onDelete: (folderId: string) => void,
      confirmMessage: string,
    ) => {
      e.stopPropagation();
      if (window.confirm(confirmMessage)) {
        onDelete(folderId);
      }
    },
    [],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent, itemId: string, dataKey: string = 'itemId') => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(dataKey, itemId);
      setIsDragging(true);
    },
    [],
  );

  const handleDrop = useCallback(
    (
      e: React.DragEvent,
      folderId: string | null,
      onMoveToFolder: (itemId: string, folderId: string | null) => void,
      dataKey: string = 'itemId',
    ) => {
      e.preventDefault();
      e.stopPropagation();
      const itemId = e.dataTransfer.getData(dataKey);
      if (itemId) {
        onMoveToFolder(itemId, folderId);
      }
      setDragOverFolderId(null);
      setIsDragging(false);
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, folderId: string | null) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOverFolderId(folderId);
    },
    [],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverFolderId(null);
  }, []);

  return {
    collapsedFolders,
    dragOverFolderId,
    isDragging,
    editingFolderId,
    editingFolderName,
    editInputRef,

    groupedItems,

    toggleFolder,
    setDragOverFolderId,
    setIsDragging,
    setEditingFolderId,
    setEditingFolderName,

    handleCreateFolder,
    handleRenameFolder,
    handleSaveFolderName,
    handleDeleteFolder,

    handleDragStart,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  };
}
