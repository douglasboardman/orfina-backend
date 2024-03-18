// Presets da API
require('dotenv').config();
require('./src/config/passport');

const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const app = express();
const PORT = process.env.PORT || 3000;
const passport = require('passport');
const session = require('express-session');

// Express-session config
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  })
);

// Middlewares
app.use(bodyParser.json());
app.use(passport.initialize());

mongoose.connect(process.env.MONGODB_URI);

// Rotas
app.use('/api/categorias', require('./src/routes/categorias'));
app.use('/api/descritivos', require('./src/routes/descritivos'));
app.use('/api/agentes', require('./src/routes/agentes'));
app.use('/api/cartoes-credito', require('./src/routes/cartoesCredito'));
app.use('/api/contas', require('./src/routes/contas'));
app.use('/api/fontes-regulares', require('./src/routes/fontesRegulares'));
app.use('/api/pagamentos-regulares', require('./src/routes/pagamentosRegulares'));
app.use('/api/lancamentos', require('./src/routes/lancamentos'));
app.use('/api/auth', require('./src/routes/authRoutes'))

// Subindo API
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});