import { render } from '@testing-library/react';
import React from 'react';

import { LoadingScreen } from '@/components/Chat/LoadingScreen';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

describe('LoadingScreen', () => {
  it('renders loading screen', () => {
    const { container } = render(<LoadingScreen />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('displays breathing animation circle', () => {
    const { container } = render(<LoadingScreen />);

    const breathingCircle = container.querySelector('.animate-breathing');
    expect(breathingCircle).toBeInTheDocument();
  });

  it('has full height and width', () => {
    const { container } = render(<LoadingScreen />);

    const wrapper = container.firstChild;
    expect(wrapper).toHaveClass('h-full');
    expect(wrapper).toHaveClass('w-full');
  });

  it('centers content', () => {
    const { container } = render(<LoadingScreen />);

    const wrapper = container.firstChild;
    expect(wrapper).toHaveClass('items-center');
    expect(wrapper).toHaveClass('justify-center');
  });

  it('has correct background color classes', () => {
    const { container } = render(<LoadingScreen />);

    const wrapper = container.firstChild;
    expect(wrapper).toHaveClass('bg-white');
    expect(wrapper).toHaveClass('dark:bg-[#212121]');
  });

  it('breathing circle has correct styling', () => {
    const { container } = render(<LoadingScreen />);

    const circle = container.querySelector('.animate-breathing');
    expect(circle).toHaveClass('h-8');
    expect(circle).toHaveClass('w-8');
    expect(circle).toHaveClass('rounded-full');
    expect(circle).toHaveClass('bg-gray-500');
    expect(circle).toHaveClass('dark:bg-gray-400');
  });

  it('has flex layout', () => {
    const { container } = render(<LoadingScreen />);

    const wrapper = container.firstChild;
    expect(wrapper).toHaveClass('flex');
  });

  it('matches snapshot', () => {
    const { container } = render(<LoadingScreen />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
