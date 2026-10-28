import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Home from '../pages/index';

describe('Home page', () => {
  it('renders the product name and tagline', () => {
    render(<Home />);

    expect(screen.getByRole('heading', { level: 1, name: 'Evidomo' })).toBeDefined();
    expect(screen.getByText(/evidence for every home/i)).toBeDefined();
  });
});
