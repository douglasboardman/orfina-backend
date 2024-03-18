const express = require('express');
const router = express.Router();
const descritivosController = require('../controllers/descritivosController');
const { protegerRota } = require('../middlewares/authMiddleware');

router.use(protegerRota);

router.get('/:id', descritivosController.retornarDescritivo);
router.get('/listar', descritivosController.listarDescritivos);
router.get('/listarPorCategoria/:categoriaId', descritivosController.listarDescritivosPorCategoria);
router.post('/cadastrar', descritivosController.criarDescritivo);
router.put('/editar/:id', descritivosController.editarDescritivo);
router.delete('/excluir/:id', descritivosController.excluirDescritivo);

module.exports = router;
