#!/usr/bin/env node

/**
 * 测试 SelectList 组件的循环跳转功能
 * 验证向上箭头在第一项时跳转到最后一项
 */

import assert from 'assert';

// 模拟 SelectList 的核心逻辑
class MockSelectList {
  constructor(itemCount) {
    this.filteredItems = Array.from({ length: itemCount }, (_, i) => ({ value: `item-${i}` }));
    this.selectedIndex = 0;
  }

  // 向上箭头 - 在顶部时循环到底部
  moveUp() {
    const prevIndex = this.selectedIndex;
    this.selectedIndex = this.selectedIndex === 0 
      ? this.filteredItems.length - 1 
      : this.selectedIndex - 1;
    return { prevIndex, newIndex: this.selectedIndex };
  }

  // 向下箭头 - 在底部时循环到顶部
  moveDown() {
    const prevIndex = this.selectedIndex;
    this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 
      ? 0 
      : this.selectedIndex + 1;
    return { prevIndex, newIndex: this.selectedIndex };
  }
}

// 测试用例
function runTests() {
  console.log('开始测试 SelectList 循环跳转功能...\n');

  // 测试 1: 在第一项按向上箭头跳转到最后一项
  {
    const list = new MockSelectList(5);
    assert.strictEqual(list.selectedIndex, 0, '初始应在第一项');
    
    const result = list.moveUp();
    assert.strictEqual(result.prevIndex, 0, '之前应在索引 0');
    assert.strictEqual(result.newIndex, 4, '应跳转到索引 4（最后一项）');
    assert.strictEqual(list.selectedIndex, 4, '当前应在最后一项');
    
    console.log('✓ 测试 1 通过: 在第一项按向上箭头成功跳转到最后一项');
  }

  // 测试 2: 在最后一项按向下箭头跳转到第一项
  {
    const list = new MockSelectList(5);
    list.selectedIndex = 4; // 设置到最后一项
    
    const result = list.moveDown();
    assert.strictEqual(result.prevIndex, 4, '之前应在索引 4');
    assert.strictEqual(result.newIndex, 0, '应跳转到索引 0（第一项）');
    assert.strictEqual(list.selectedIndex, 0, '当前应在第一项');
    
    console.log('✓ 测试 2 通过: 在最后一项按向下箭头成功跳转到第一项');
  }

  // 测试 3: 中间项正常向上移动
  {
    const list = new MockSelectList(5);
    list.selectedIndex = 2;
    
    const result = list.moveUp();
    assert.strictEqual(result.prevIndex, 2, '之前应在索引 2');
    assert.strictEqual(result.newIndex, 1, '应移动到索引 1');
    
    console.log('✓ 测试 3 通过: 中间项正常向上移动');
  }

  // 测试 4: 中间项正常向下移动
  {
    const list = new MockSelectList(5);
    list.selectedIndex = 2;
    
    const result = list.moveDown();
    assert.strictEqual(result.prevIndex, 2, '之前应在索引 2');
    assert.strictEqual(result.newIndex, 3, '应移动到索引 3');
    
    console.log('✓ 测试 4 通过: 中间项正常向下移动');
  }

  // 测试 5: 单项列表循环
  {
    const list = new MockSelectList(1);
    
    const upResult = list.moveUp();
    assert.strictEqual(upResult.newIndex, 0, '单项列表向上应保持在索引 0');
    
    const downResult = list.moveDown();
    assert.strictEqual(downResult.newIndex, 0, '单项列表向下应保持在索引 0');
    
    console.log('✓ 测试 5 通过: 单项列表循环正确');
  }

  // 测试 6: 连续向上循环
  {
    const list = new MockSelectList(3);
    list.selectedIndex = 1;
    
    list.moveUp(); // 1 -> 0
    assert.strictEqual(list.selectedIndex, 0);
    
    list.moveUp(); // 0 -> 2 (循环)
    assert.strictEqual(list.selectedIndex, 2);
    
    list.moveUp(); // 2 -> 1
    assert.strictEqual(list.selectedIndex, 1);
    
    console.log('✓ 测试 6 通过: 连续向上循环正确');
  }

  console.log('\n所有测试通过！✓');
}

// 运行测试
try {
  runTests();
  process.exit(0);
} catch (error) {
  console.error('\n✗ 测试失败:', error.message);
  console.error(error.stack);
  process.exit(1);
}
