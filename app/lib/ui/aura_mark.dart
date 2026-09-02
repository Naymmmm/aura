import 'dart:math' as math;

import 'package:flutter/material.dart';

class AuraMark extends StatelessWidget {
  const AuraMark({super.key, this.size = 28, this.color});

  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size.square(size),
      painter: _AsteriskPainter(
        color ?? Theme.of(context).colorScheme.onPrimary,
      ),
    );
  }
}

class _AsteriskPainter extends CustomPainter {
  const _AsteriskPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.shortestSide * 0.43;
    final paint = Paint()
      ..color = color
      ..strokeWidth = size.shortestSide * 0.12
      ..strokeCap = StrokeCap.square;
    for (var i = 0; i < 4; i++) {
      final angle = math.pi * i / 4;
      final delta = Offset(math.cos(angle), math.sin(angle)) * radius;
      canvas.drawLine(center - delta, center + delta, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _AsteriskPainter oldDelegate) =>
      oldDelegate.color != color;
}
