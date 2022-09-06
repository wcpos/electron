import * as React from 'react';
import { createRoot } from 'react-dom/client';
// import { render } from 'react-dom';
import './app.global.css';
import App from '@wcpos/core';

const container = document.getElementById('root');
const root = createRoot(container!); // createRoot(container!) if you use TypeScript
root.render(<App />);

// render(
// 	<React.StrictMode>
// 		<App />
// 	</React.StrictMode>,
// 	document.getElementById('root')
// );
