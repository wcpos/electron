import * as React from 'react';
// import { createRoot } from 'react-dom/client';
import { render } from 'react-dom';
import './app.global.css';
import App from '@wcpos/core';

// FIXME need reanimated update, see https://github.com/software-mansion/react-native-reanimated/issues/3355
window._frameTimestamp = null;

const container = document.getElementById('root');

/**
 * @TODO - when I use conconcurrent mode, the product list re-renders many times
 * It's possible that flashlist or recyclelistview is not compatible with concurrent mode?
 */
// const root = createRoot(container!); // createRoot(container!) if you use TypeScript
// root.render(<App />);

/**
 * Fallback to React 17 render until expo updates explicitly to concurrent mode
 */
render(<App />, container);
