const express = require('express');
const path = require('path');

const app = express();
const PORT = 3001;

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Test server running on port ${PORT}`);
  console.log(`Assets available at http://localhost:${PORT}/assets/logos/`);
});
