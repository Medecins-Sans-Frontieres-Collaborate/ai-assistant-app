import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { TemperatureSlider } from '@/components/Settings/Temperature';

import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      temperatureDescription:
        'Higher values will make the output more random, while lower values will make it more focused and deterministic.',
      Precise: 'Precise',
      Neutral: 'Neutral',
      Creative: 'Creative',
    };
    return translations[key] || key;
  },
}));

describe('TemperatureSlider', () => {
  const mockOnChangeTemperature = vi.fn();

  beforeEach(() => {
    mockOnChangeTemperature.mockClear();
  });

  it('renders temperature slider', () => {
    render(
      <TemperatureSlider
        temperature={0.7}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    const slider = screen.getByRole('slider');
    expect(slider).toBeInTheDocument();
  });

  it('displays current temperature value', () => {
    render(
      <TemperatureSlider
        temperature={0.7}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    expect(screen.getByText('0.7')).toBeInTheDocument();
  });

  it('displays temperature description', () => {
    render(
      <TemperatureSlider
        temperature={0.5}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    expect(
      screen.getByText(/Higher values will make the output more random/),
    ).toBeInTheDocument();
  });

  it('displays temperature labels', () => {
    render(
      <TemperatureSlider
        temperature={0.5}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    expect(screen.getByText('Precise')).toBeInTheDocument();
    expect(screen.getByText('Neutral')).toBeInTheDocument();
    expect(screen.getByText('Creative')).toBeInTheDocument();
  });

  it('has correct slider attributes', () => {
    render(
      <TemperatureSlider
        temperature={0.5}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider).toHaveAttribute('type', 'range');
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', '1');
    expect(slider).toHaveAttribute('step', '0.1');
  });

  it('calls onChangeTemperature when slider is moved', () => {
    render(
      <TemperatureSlider
        temperature={0.5}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '0.8' } });

    expect(mockOnChangeTemperature).toHaveBeenCalledTimes(1);
    expect(mockOnChangeTemperature).toHaveBeenCalledWith(0.8);
  });

  it('updates display when temperature prop changes', () => {
    const { rerender } = render(
      <TemperatureSlider
        temperature={0.3}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    expect(screen.getByText('0.3')).toBeInTheDocument();

    rerender(
      <TemperatureSlider
        temperature={0.9}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    expect(screen.getByText('0.9')).toBeInTheDocument();
    expect(screen.queryByText('0.3')).not.toBeInTheDocument();
  });

  it('handles minimum temperature value (0)', () => {
    render(
      <TemperatureSlider
        temperature={0}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    expect(screen.getByText('0.0')).toBeInTheDocument();
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.value).toBe('0');
  });

  it('handles maximum temperature value (1)', () => {
    render(
      <TemperatureSlider
        temperature={1}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    expect(screen.getByText('1.0')).toBeInTheDocument();
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.value).toBe('1');
  });

  it('formats temperature to one decimal place', () => {
    const { rerender } = render(
      <TemperatureSlider
        temperature={0.123456}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    expect(screen.getByText('0.1')).toBeInTheDocument();

    rerender(
      <TemperatureSlider
        temperature={0.789}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    expect(screen.getByText('0.8')).toBeInTheDocument();
  });

  it('calls onChangeTemperature with multiple values', () => {
    render(
      <TemperatureSlider
        temperature={0.5}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    const slider = screen.getByRole('slider');

    fireEvent.change(slider, { target: { value: '0.2' } });
    fireEvent.change(slider, { target: { value: '0.6' } });
    fireEvent.change(slider, { target: { value: '0.9' } });

    expect(mockOnChangeTemperature).toHaveBeenCalledTimes(3);
    expect(mockOnChangeTemperature).toHaveBeenNthCalledWith(1, 0.2);
    expect(mockOnChangeTemperature).toHaveBeenNthCalledWith(2, 0.6);
    expect(mockOnChangeTemperature).toHaveBeenNthCalledWith(3, 0.9);
  });

  it('has correct CSS classes for styling', () => {
    const { container } = render(
      <TemperatureSlider
        temperature={0.5}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    const slider = container.querySelector('input[type="range"]');
    expect(slider).toHaveClass('cursor-pointer');
    expect(slider).toHaveClass('accent-[#D7211E]');
  });

  it('renders labels in correct layout', () => {
    const { container } = render(
      <TemperatureSlider
        temperature={0.5}
        onChangeTemperature={mockOnChangeTemperature}
      />,
    );

    const labelList = container.querySelector('ul');
    expect(labelList).toBeInTheDocument();
    expect(labelList).toHaveClass('flex');
    expect(labelList).toHaveClass('justify-between');

    const labels = labelList?.querySelectorAll('li');
    expect(labels?.length).toBe(3);
  });
});
