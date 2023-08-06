const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'dist', 'index.html');
let htmlContent = fs.readFileSync(indexPath, 'utf8');
htmlContent = htmlContent.replace('src="/bundles', 'src="bundles');
fs.writeFileSync(indexPath, htmlContent);
