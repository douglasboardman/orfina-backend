const passport = require('passport');
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
const dotenv = require('dotenv');
const User = require('../models/usuarioModel');

dotenv.config();

const options = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: process.env.JWT_SECRET,
};

passport.use(
    new JwtStrategy(options, async (jwtPayload, done) => {
      try {
        const user = await User.findById(jwtPayload.userId);
  
        if (user) {
          return done(null, user);
        } else {
          return done(null, false, { message: 'Usuário não encontrado' });
        }
      } catch (error) {
        return done(error, false);
      }
    })
);