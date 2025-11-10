import { useCallback, useState } from 'react';

export interface UseModalFormReturn<T> {
  isOpen: boolean;
  formData: T;
  itemId: string | null;

  openNew: () => void;
  openEdit: (id: string, data: T) => void;
  close: () => void;
  updateField: <K extends keyof T>(field: K, value: T[K]) => void;
  setFormData: (data: T) => void;
  reset: () => void;
}

export interface UseModalFormOptions<T> {
  initialState: T;
}

export function useModalForm<T extends Record<string, any>>({
  initialState,
}: UseModalFormOptions<T>): UseModalFormReturn<T> {
  const [isOpen, setIsOpen] = useState(false);
  const [formData, setFormDataState] = useState<T>(initialState);
  const [itemId, setItemId] = useState<string | null>(null);

  const openNew = useCallback(() => {
    setFormDataState(initialState);
    setItemId(null);
    setIsOpen(true);
  }, [initialState]);

  const openEdit = useCallback((id: string, data: T) => {
    setFormDataState(data);
    setItemId(id);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setFormDataState(initialState);
    setItemId(null);
  }, [initialState]);

  const updateField = useCallback(
    <K extends keyof T>(field: K, value: T[K]) => {
      setFormDataState((prev) => ({
        ...prev,
        [field]: value,
      }));
    },
    [],
  );

  const setFormData = useCallback((data: T) => {
    setFormDataState(data);
  }, []);

  const reset = useCallback(() => {
    setFormDataState(initialState);
    setItemId(null);
  }, [initialState]);

  return {
    isOpen,
    formData,
    itemId,
    openNew,
    openEdit,
    close,
    updateField,
    setFormData,
    reset,
  };
}
